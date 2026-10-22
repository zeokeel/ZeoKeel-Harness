// Package queue 实现 WASM 应用平台的**请求准入与排队**（设计基线 §4.6）。
//
// 全部上限（每应用并发 / 队列 32 / 排队体 256 MiB / 每用户每应用占槽 4 /
// 每用户全局在跑 4 / 全局实例 32 / 端到端墙钟 60 s）都来自 limits 包，
// 本包不引入新数值。
//
// 语义（§4.6 + §10.3 第 32–34 项）：
//   - **每应用并发 = limits.AppRuntimeConcurrency（默认 4）**：同一应用同一时刻最多 N 个
//     请求在跑；第 N+1 个进队列。⚠️ 2026-09-19 之前 N 恒为 1（"每应用串行"）——
//     那是"应用库一应用一连接"时代的队列侧保证；appdb 改造（WAL + 1 写 N 读连接池 +
//     读写锁拆分）之后同应用并发读已是真实能力，继续钉在 1 只会让默认部署白排队。
//     写仍然是串行的：并发控制在 appdb（写走 writeMu），队列在这里只放行，不管读写。
//   - **每应用队列 32**：超出直接 429 + Retry-After（不排队等待，避免无界内存）；
//   - **排队请求体 256 MiB（全局）**：`limits.WasmQueueBodyBytesMax`。请求体在准入**之前**
//     就已读进内存（慢客户端不得占着执行槽，见 appserver.serveWasm），所以**条数**上限
//     管不住内存：`app_queue` 的合法上界是 4096，配满就是 4096 × 1 MiB ≈ 4 GiB。
//     本包因此另立一笔**全局字节**预算（`Options.QueueBodyBytes`）：所有应用、所有等待者
//     的已读请求体合计超它即 fail-closed 429（details.reason=queue_bytes_exceeded），
//     离队（授权/超时/被拒）时归还。⚠️ 生产路径必须用 `AcquireWithSize` 把**真实**体长
//     传进来；`Acquire` 是"没有体"的旧入口（等价于 0 字节），传错等于让这笔账失效。
//   - **每用户在**同一应用**内**：同时最多 2 个在跑、队列中最多 4 个
//     ⇒ 防单用户占满该应用队列（2026-10-22 由 1 提到 2：`Promise.all` 两个请求、
//     页面初始化"列表 + 配置"这类最正常用法不该被单用户并发上限串行，
//     见 docs/decisions/2026-10-22-wasm-per-app-limits.md §1）；
//   - **每用户全局在跑 4**（跨应用聚合）：防止单用户开 20 个应用占满全局 32 槽；
//   - **全局在跑 32**：跨应用耗尽保护；
//   - **端到端墙钟 60 s（含排队等待）**：到点即拒 —— 由调用方传入带 deadline 的 ctx
//     实现（本包在等待期间只观察 ctx，不自己造 deadline，以免与请求级 deadline 打架）。
//
// **应用级覆盖**（决策 2026-10-22 §2.2）：上面四个"每应用/每用户在应用内"的上限
// 可以按 `app_id` 覆盖（`SetAppLimitOverride`），其余（全局实例 32 / 每用户跨应用 4 /
// 排队体字节 / 端到端墙钟）恒用全局值 —— 排队内存是"进程能不能活"的判据，
// 不是某个应用的属性。生效值由 `effectiveOptionsLocked` 唯一计算，
// 准入、队列容量与唤醒三处都读它。
//
// 公平性与 HO-L 阻塞：释放槽位时按 **FIFO 顺序扫描**等待队列并授权所有"当前可运行"的
// 请求，跳过那些会突破"每用户全局在跑"上限的请求（它们留在队列里，不丢、不报错）。
// 如果改为"队首不能跑就整队等待"，单个占了 4 个全局槽的用户会把整个应用卡死。
package queue

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
)

// Options 是调度器上限（零值字段用 limits 缺省填充）。
type Options struct {
	// GlobalRunning 是全局并发实例上限（§4.6）。
	GlobalRunning int
	// PerAppRunning 是每应用并发（§4.6：limits.AppRuntimeConcurrency，默认 4）。
	//
	// 它是**每应用同时运行数**，不是"是否串行"：超出它的请求进队列（PerAppQueue）。
	// 写路径的串行由 appdb 的 writeMu 保证，不靠这里。
	PerAppRunning int
	// PerAppQueue 是每应用队列长度（§4.6：32）。
	PerAppQueue int
	// PerUserPerAppRunning 是单用户在同一应用内同时运行数（§4.6；默认 limits.UserPerAppRunning=2）。
	PerUserPerAppRunning int
	// PerUserPerAppQueued 是单用户在同一应用队列中的占位上限（§4.6：4）。
	PerUserPerAppQueued int
	// PerUserGlobalRunning 是单用户跨应用全局在跑上限（§4.6：4）。
	PerUserGlobalRunning int
	// WallClock 是请求端到端墙钟（含排队）。
	//
	// 队列**不自己造 deadline**（§4.6：两个 deadline 会让错误归属无法区分）——
	// 它只观察调用方传进来的 ctx。这个字段唯一的作用是把"当时的预算是多少"
	// 如实写进 wall_clock_exceeded 的错误明细：预算自 2026-10-01 起可由控制台配置
	// （`request_wall_clock_seconds`），明细里再写编译期常量就会说谎。
	WallClock time.Duration
	// QueueBodyBytes 是**排队请求体的全局字节预算**（生产评审管理员视角 P1-3）。
	//
	// 为什么队列需要它：`appserver.serveWasm` 在准入**之前**就把请求体读进内存
	// （慢客户端不得占着执行槽，那个顺序是对的），而排队容量只按**条数**判
	// （PerAppQueue，控制台可配到 applimits.MaxAppQueue=4096）⇒ "4096 × 1 MiB ≈ 4 GiB
	// 已读字节挂在队列里"是**合法配置**。条数闸门管不住字节，所以这里另立一笔
	// **全局**字节预算：所有应用、所有等待者的已读请求体合计不得超过它。
	//
	// 零值 ⇒ limits.WasmQueueBodyBytesMax（256 MiB，取值理由见该常量的注释）。
	// 它不受 per-app 覆盖影响（与 GlobalRunning / PerUserGlobalRunning / WallClock 同档：
	// 那是"进程能不能活"的判据，不是某个应用的属性）。
	QueueBodyBytes int64
}

// DefaultOptions 返回与 limits 包一致的缺省上限。
func DefaultOptions() Options {
	return Options{
		GlobalRunning:        limits.GlobalInstances,
		PerAppRunning:        limits.AppRuntimeConcurrency,
		PerAppQueue:          limits.AppQueueDepth,
		PerUserPerAppRunning: limits.UserPerAppRunning,
		PerUserPerAppQueued:  limits.UserPerAppQueued,
		PerUserGlobalRunning: limits.UserGlobalRunning,
		WallClock:            limits.RequestWallClock,
		QueueBodyBytes:       limits.WasmQueueBodyBytesMax,
	}
}

func (o Options) withDefaults() Options {
	d := DefaultOptions()
	if o.GlobalRunning <= 0 {
		o.GlobalRunning = d.GlobalRunning
	}
	if o.PerAppRunning <= 0 {
		o.PerAppRunning = d.PerAppRunning
	}
	if o.PerAppQueue <= 0 {
		o.PerAppQueue = d.PerAppQueue
	}
	if o.PerUserPerAppRunning <= 0 {
		o.PerUserPerAppRunning = d.PerUserPerAppRunning
	}
	if o.PerUserPerAppQueued <= 0 {
		o.PerUserPerAppQueued = d.PerUserPerAppQueued
	}
	if o.PerUserGlobalRunning <= 0 {
		o.PerUserGlobalRunning = d.PerUserGlobalRunning
	}
	if o.WallClock <= 0 {
		o.WallClock = d.WallClock
	}
	if o.QueueBodyBytes <= 0 {
		o.QueueBodyBytes = d.QueueBodyBytes
	}
	return o
}

// Stats 是队列水位（§4.9 /readyz 与 /api/zeokeel/... 观测面用）。
type Stats struct {
	// GlobalRunning 是当前全局在跑数。
	GlobalRunning int `json:"global_running"`
	// Waiting 是当前全部等待者数量。
	Waiting int `json:"waiting"`
	// Apps 是有等待者的应用数。
	Apps int `json:"apps"`
	// TrackedApps 是 app 状态表的条目数（= 在跑或有等待者的应用数；空闲条目会被回收）。
	//
	// 为什么要暴露它：准入成本只应与"活跃应用数"成正比，而**历史上出现过的应用数**
	// 曾经是成本的分母（审计 P2-3：20000 个空闲应用时单次 Acquire+Release 516–811 µs，
	// 且全程持全局锁）。这个字段让"表有没有被回收"在运维面上可验证。
	TrackedApps int `json:"apps_tracked"`
	// RejectedQueueFull 是累计"应用队列满/用户占位满"被拒的请求数（429）。
	// 生产评审管理员视角 P1：429 此前不计数、不打日志，运维面无法回答
	// "哪个应用在拖垮平台/为什么用户一直失败"。
	RejectedQueueFull int64 `json:"rejected_queue_full"`
	// RejectedWallClock 是累计"排队超过端到端墙钟"被拒的请求数（429 wall_clock_exceeded）。
	RejectedWallClock int64 `json:"rejected_wall_clock"`
	// RejectedQueueBytes 是累计"排队请求体字节预算已满"被拒的请求数
	// （429 APP_QUEUE_FULL + details.reason=queue_bytes_exceeded，生产评审 P1-3）。
	//
	// 与 RejectedQueueFull 分开计的理由：两者的**成因与处置完全不同** ——
	// 前者是"这一个应用的队列满"（等它排空即可），后者是"平台上别的应用把全局
	// 排队内存吃满了"（要么扩容/调低 app_queue，要么查出是谁在压）。
	RejectedQueueBytes int64 `json:"rejected_queue_bytes"`
	// QueuedBodyBytes 是**此刻**全部等待者已读入内存的请求体字节合计。
	//
	// 不变量（由 queue_bodybudget_test.go 断言）：它恒等于所有 appState.queuedBytes 之和，
	// 也恒等于所有在队 waiter 的 bodyBytes 之和；授权/超时/被拒三条离开队列的路径都必须
	// 归还额度，否则计数漂移会让"预算已满"永久误判（比 OOM 更难查：账面上没内存用，
	// 实际上队列是空的）。
	QueuedBodyBytes int64 `json:"queued_body_bytes"`
	// MaxQueuedBodyBytes 是 QueuedBodyBytes 的**历史峰值**（只增不减，进程内）。
	//
	// 为什么要有峰值：瞬时水位在轮询（/admin/runtime、/readyz）里几乎总是读到 0 ——
	// "刚才有没有撞到 256 MiB 的水位"这个问题只有峰值能回答。
	MaxQueuedBodyBytes int64 `json:"max_queued_body_bytes"`
	// QueueBodyBytesLimit 是当前的排队体预算（= Options.QueueBodyBytes，缺省
	// limits.WasmQueueBodyBytesMax）。下发它，管理面才能说清"离撞墙还有多远"。
	QueueBodyBytesLimit int64 `json:"queue_body_bytes_limit"`
}

// Scheduler 是应用请求调度器（进程内存态；单实例部署 R20）。
type Scheduler struct {
	opt Options

	// 429 计数（生产评审管理员视角 P1）：只做过程计数，不做策略；按应用分别记
	// 便于管理面回答"哪个应用在持续撞队列"（rejectedByApp 只在拒绝时创建条目，
	// 与 appOverrides 一样是例外表，不随应用数无限增长——应用删除后条目会被
	// Release 清掉；更简单地说：条目数 ≤ 曾撞过队列的应用数，生产上限=应用数）。
	rejectedQueueFull int64
	rejectedWallClock int64
	// rejectedQueueBytes 见 Stats.RejectedQueueBytes（P1-3：全局排队体预算）。
	rejectedQueueBytes int64
	rejectedByApp      map[string]int64

	// appOverrides 是**应用级覆盖**（决策 docs/decisions/2026-10-22-wasm-per-app-limits.md
	// §2.2）：appID → 四个并发轴的覆盖。只在内存里，真源是 `wasm_app_limits`（PG）。
	//
	// 为什么是"一张独立的表"而不是把覆盖折进 appState：appState 只在"在跑/有等待者"
	// 时存在（空闲即回收，见 dropIfIdleLocked），而覆盖必须**在首次请求之前**就生效
	// （启动期从库装载）。两者生命周期不同，混在一起会让"清空覆盖"在空闲应用上
	// 需要先造一个 appState 才能表达。
	//
	// 只影响四轴（PerAppRunning / PerAppQueue / PerUserPerAppRunning / PerUserPerAppQueued）；
	// GlobalRunning / PerUserGlobalRunning / WallClock 恒用全局（决策 §2.2）。
	appOverrides map[string]limits.AppOverride

	mu            sync.Mutex
	apps          map[string]*appState
	active        map[string]struct{}
	userRunning   map[int64]int
	globalRunning int
	waiting       int
	// queuedBodyBytes 是**此刻**所有在队请求的已读请求体字节合计（P1-3）。
	// 受 s.mu 保护；只在入队时加、离开队列时减，不变量见 Stats.QueuedBodyBytes。
	queuedBodyBytes int64
	// maxQueuedBodyBytes 是 queuedBodyBytes 的历史峰值（只增不减）。
	maxQueuedBodyBytes int64
	// pumpScans 是 pumpAllLocked 累计遍历的应用条目数（**性能回归口径**：
	// 遍历成本必须与"活跃应用数"成正比，而不是与历史上出现过的应用数成正比）。
	pumpScans int64
}

type appState struct {
	running int
	// runningUsers 是在跑请求的发起者计数（userID → 该用户在本应用内的在跑数）。
	//
	// 为什么必须是计数表而不是"单个发起者"（2026-09-19）：PerAppRunning 的默认值从 1
	// 提到 4 之后，同一应用里可以同时有**多个不同用户**在跑。老实现只记最后一个发起者
	// （runningUser int64 + "恒为 1 ⇒ 单值即可"），一旦有第二个用户进来就把第一个
	// 覆盖掉 ⇒ userRunningOf(A) 读到 0，"单用户单应用并发 = 1"对**先来的**用户静默失效。
	// 表随应用条目一起回收（dropIfIdleLocked），不构成新的常驻。
	runningUsers map[int64]int
	waiters      []*waiter
	userQueued   map[int64]int
	// queuedBytes 是本应用在队请求的已读请求体字节合计（P1-3）。
	//
	// 为什么要按应用再记一份：全局 queuedBodyBytes 只回答"平台还有多少预算"，
	// 而管理面要回答的是"**哪个应用**把排队内存吃掉了"（/admin/runtime 的 top_apps）。
	// 增量维护（入队加、离队减）而不是每次遍历 waiters 求和 —— 后者在
	// "4096 深队列"这种正是本笔账要防的形态下是 O(N) 轮询成本。
	queuedBytes int64
}

type waiter struct {
	userID int64
	ch     chan struct{}
	// granted 由授权方置位（在 s.mu 保护下），等待方据 ch 关闭 + granted 判定。
	granted bool
	// bodyBytes 是该等待者已读入内存的请求体字节数（P1-3）。
	//
	// 它是**归还额度的唯一凭据**：授权（pumpAppLocked）与超时/摘除
	// （removeWaiterLocked）都按它归还，归还后立即置 0 ⇒ 同一条 waiter 不会
	// 被归还两次（幂等点在数据上，而不靠调用方记得）。
	bodyBytes int64
}

// New 创建调度器。
func New(opt Options) *Scheduler {
	return &Scheduler{
		opt:           opt.withDefaults(),
		appOverrides:  map[string]limits.AppOverride{},
		rejectedByApp: map[string]int64{},
		apps:          map[string]*appState{},
		active:        map[string]struct{}{},
		userRunning:   map[int64]int{},
	}
}

// Ticket 是一次已获准运行的请求凭证（必须 Release；重复 Release 安全）。
type Ticket struct {
	appID  string
	userID int64
	once   sync.Once
	sched  *Scheduler
	// EnqueuedMS 是本次请求在队列中等待的毫秒数（§4.9 queue_wait_ms 字段）。
	EnqueuedMS int64
}

// Release 归还槽位并唤醒可运行的等待者。
func (t *Ticket) Release() {
	if t == nil || t.sched == nil {
		return
	}
	t.once.Do(func() { t.sched.release(t.appID, t.userID) })
}

// AppID 返回该凭证对应的应用（诊断用）。
func (t *Ticket) AppID() string { return t.appID }

// Acquire 申请一个运行槽位（**不占排队体预算**，等价于体字节为 0 的准入）。
//
// 它保留给两类调用方：① 请求体在准入之后才读到/根本没有体的路径；② 既有测试与
// 诊断调用。**生产请求路径必须用 AcquireWithSize** —— 服务端在准入前就把体读进
// 内存（`appserver.serveWasm`），用本函数等于告诉调度器"我没有占内存"，
// 全局排队体预算就会静默失效（详见 AcquireWithSize 与 limits.WasmQueueBodyBytesMax）。
//
// 语义、失败码与 userID 约定同 AcquireWithSize。
func (s *Scheduler) Acquire(ctx context.Context, appID string, userID int64) (*Ticket, *apperr.Error) {
	return s.AcquireWithSize(ctx, appID, userID, 0)
}

// AcquireWithSize 申请一个运行槽位，并把**已读入内存的请求体字节数**如实入账。
//
// 语义见包注释。失败时返回：
//   - APP_QUEUE_FULL(429)：该应用队列已满，或该用户在本应用的占位已达上限；
//   - APP_QUEUE_FULL(429, details.reason=wall_clock_exceeded)：ctx 在排队期间到期
//     （端到端墙钟 60 s 到点即拒，§4.6）；
//   - APP_QUEUE_FULL(429, details.reason=queue_bytes_exceeded)：**全局**排队体预算
//     已满（生产评审 P1-3）—— 不是这个应用的问题，是平台上等待中的请求体太多了。
//
// bodyBytes 的记账规则（唯一实现见 chargeQueuedBodyLocked / refundQueuedBodyLocked）：
//   - 只在**真的进队列**时占账（快路径直接授权的请求不占：它不"挂在队列里"，
//     其体字节由全局并发（≤ GlobalRunning × 单请求体上限）约束）；
//   - 离开队列的**三条**路径都必须归还：被授权（pumpAppLocked）、超时/取消
//     （removeWaiterLocked）、以及"授权与超时竞态"（授权方已经归还）。
//     归还在 waiter.bodyBytes 上做幂等（归还后置 0），不靠调用方记得；
//   - bodyBytes ≤ 0（未提供/未知）按 0 处理：这不改变"上界"语义 ——
//     真正的防线是调用方在准入前已经读过体、因此**知道**它的长度；这条退路
//     只为兼容旧调用点与测试，生产路径见 appserver/serve.go。
//
// userID 传 0 表示"没有身份"（不参与"每用户在跑"计数，但仍受全局与每应用上限约束）。
//
// ⚠️ 服务端**没有匿名面**（管线一律要求登录）：0 只可能来自装配/测试错误，
// 这条分支留着只是为了让调度器对"没有身份"保持 fail-closed 的计数语义。
func (s *Scheduler) AcquireWithSize(ctx context.Context, appID string, userID int64,
	bodyBytes int64) (*Ticket, *apperr.Error) {
	if bodyBytes < 0 {
		bodyBytes = 0
	}
	start := time.Now()
	s.mu.Lock()
	// 本应用的**生效上限**（全局 + 应用级覆盖，见 effectiveOptionsLocked）：
	// 队列容量与"每用户占位"必须按它判，否则"给某个应用单独限流"就只影响放行、
	// 不影响排队 —— 排进队列的请求仍然按全局队列长度占位（决策 §2.2/§2.4）。
	eff := s.effectiveOptionsLocked(appID)

	// 快路径：无需排队直接授权。
	if s.canRunLocked(appID, userID) {
		s.grantLocked(appID, userID)
		s.mu.Unlock()
		return &Ticket{appID: appID, userID: userID, sched: s}, nil
	}

	// 队列容量检查（应用级 + 用户级占位）。
	//
	// ⚠️ 计数一律在**持锁期间**递增（历史上这三处是 `s.mu.Unlock()` 之后再
	// `s.rejectedXxx++` / `s.rejectedByApp[appID]++`）：那是对受锁保护字段的
	// 无锁写 —— 计数器会丢更新，而 map 的并发写是**直接崩溃**（不是概率性误报）。
	// 它们会被 /readyz 与管理面从别的 goroutine 读，所以必须回到锁内。
	as := s.appLocked(appID)
	if len(as.waiters) >= eff.PerAppQueue {
		s.dropIfIdleLocked(appID, as) // 满了说明这个应用不空；但别把"纯新建的空条目"留下
		s.rejectedQueueFull++
		s.rejectedByApp[appID]++
		s.mu.Unlock()
		return nil, apperr.New(apperr.CodeAppQueueFull, "应用队列已满").
			WithDetail("queue_depth", eff.PerAppQueue).
			WithHint(fmt.Sprintf("稍后重试；该应用同时最多处理 %d 个请求", eff.PerAppRunning))
	}
	if userID != 0 && as.userQueued[userID] >= eff.PerUserPerAppQueued {
		s.dropIfIdleLocked(appID, as)
		s.rejectedQueueFull++
		s.rejectedByApp[appID]++
		s.mu.Unlock()
		return nil, apperr.New(apperr.CodeAppQueueFull, "你在该应用排队中的请求过多").
			WithDetail("per_user_queued", eff.PerUserPerAppQueued).
			WithHint(fmt.Sprintf("同一应用内你同时最多 %d 个请求在跑、%d 个排队",
				eff.PerUserPerAppRunning, eff.PerUserPerAppQueued))
	}
	// 全局排队体预算（P1-3）：**fail-closed**。放在两条条数闸门之后 ——
	// "这个应用的队列满了"比"平台上别的应用吃满了排队内存"更具体、也更可操作，
	// 两者同时成立时应先告诉调用方前一个。
	//
	// 判据是"加上这一个之后是否超过预算"，而不是"当前是否已满"：
	// 后者会放过"最后一个刚好把预算撑到 300 MiB"的请求（超卖一次，就可能多出
	// 一个 1 MiB 的常驻）。
	if bodyBytes > 0 {
		limit := s.opt.QueueBodyBytes
		if bodyBytes > limit || s.queuedBodyBytes+bodyBytes > limit {
			queued, maxQueued := s.queuedBodyBytes, s.maxQueuedBodyBytes
			s.rejectedQueueBytes++
			s.rejectedByApp[appID]++
			s.dropIfIdleLocked(appID, as)
			s.mu.Unlock()
			return nil, apperr.New(apperr.CodeAppQueueFull, "平台排队内存已满").
				WithDetail("reason", "queue_bytes_exceeded").
				WithDetail("queued_body_bytes", queued).
				WithDetail("queue_body_bytes_limit", limit).
				WithDetail("request_body_bytes", bodyBytes).
				WithDetail("peak_body_bytes", maxQueued).
				WithHint(fmt.Sprintf("稍后重试；平台所有应用**排队中**的请求体合计上限 %s"+
					"（此刻 %s），单个请求体上限 %s —— 大请求请拆小或减少并发",
					fmtBytes(limit), fmtBytes(queued), fmtBytes(limits.AppRequestBodyMaxBytes)))
		}
	}

	w := &waiter{userID: userID, ch: make(chan struct{})}
	as.waiters = append(as.waiters, w)
	if userID != 0 {
		as.userQueued[userID]++
	}
	s.active[appID] = struct{}{} // 有等待者 ⇒ 进入活跃集合（pumpAllLocked 只遍历它）
	s.waiting++
	s.chargeQueuedBodyLocked(as, w, bodyBytes)
	s.mu.Unlock()

	select {
	case <-w.ch:
		// 已被授权（granted 在锁内置位后才关闭 ch，见 grantLocked）。
		return &Ticket{appID: appID, userID: userID, sched: s, EnqueuedMS: time.Since(start).Milliseconds()}, nil
	case <-ctx.Done():
		// 计数与摘除必须在**同一个临界区**里做（无锁自增会丢更新，map 的无锁写会崩）。
		s.mu.Lock()
		grantRace := w.granted
		if !grantRace {
			// 还在队 ⇒ 摘除并归还它占的排队体额度（removeWaiterLocked 内部做）。
			s.removeWaiterLocked(appID, w)
		}
		s.rejectedWallClock++
		s.rejectedByApp[appID]++
		wallClock := s.opt.WallClock
		s.mu.Unlock()
		if grantRace {
			// 竞态：等待期间被并发授权 ⇒ 立刻归还槽位，仍按超时返回。
			// （排队体额度已由授权方归还，见 pumpAppLocked —— 这里不再重复归还。）
			t := &Ticket{appID: appID, userID: userID, sched: s, EnqueuedMS: time.Since(start).Milliseconds()}
			t.Release()
		}
		return nil, apperr.New(apperr.CodeAppQueueFull, "请求超时（含排队等待超过端到端墙钟）").
			WithDetail("reason", "wall_clock_exceeded").
			WithDetail("wall_clock_ms", wallClock.Milliseconds()).
			WithHint("应用当前繁忙，请稍后重试")
	}
}

// canRunLocked 判定某请求此刻能否直接运行（调用方必须持锁）。
func (s *Scheduler) canRunLocked(appID string, userID int64) bool {
	// 生效上限 = 全局 + 本应用覆盖（决策 §2.2）：全局并发/墙钟仍然恒用全局值。
	eff := s.effectiveOptionsLocked(appID)
	if s.globalRunning >= s.opt.GlobalRunning {
		return false
	}
	as := s.appLocked(appID)
	if as.running >= eff.PerAppRunning {
		return false
	}
	if userID != 0 {
		if s.userRunning[userID] >= s.opt.PerUserGlobalRunning {
			return false
		}
		if as.userRunningOf(userID) >= eff.PerUserPerAppRunning {
			return false
		}
	}
	return true
}

// userRunningOf 统计某用户在该应用内正在运行的请求数（0 = 该用户在本应用没有在跑）。
func (as *appState) userRunningOf(userID int64) int {
	if userID == 0 || as.runningUsers == nil {
		return 0
	}
	return as.runningUsers[userID]
}

// grantLocked 记账一次授权（调用方必须持锁）。
func (s *Scheduler) grantLocked(appID string, userID int64) {
	as := s.appLocked(appID)
	as.running++
	if userID != 0 {
		if as.runningUsers == nil {
			as.runningUsers = map[int64]int{}
		}
		as.runningUsers[userID]++
	}
	s.globalRunning++
	if userID != 0 {
		s.userRunning[userID]++
	}
	s.active[appID] = struct{}{} // 在跑 ⇒ 活跃（唤醒时要能被遍历到）
}

// release 归还槽位并唤醒可运行者。
func (s *Scheduler) release(appID string, userID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	as := s.appLocked(appID)
	if as.running > 0 {
		as.running--
	}
	if userID != 0 && as.runningUsers != nil {
		if as.runningUsers[userID] > 1 {
			as.runningUsers[userID]--
		} else {
			delete(as.runningUsers, userID)
		}
	}
	if s.globalRunning > 0 {
		s.globalRunning--
	}
	if userID != 0 {
		if s.userRunning[userID] > 1 {
			s.userRunning[userID]--
		} else {
			delete(s.userRunning, userID)
		}
	}
	// 关键：释放的可能是一个**全局**槽位（全局实例 32 / 每用户全局在跑 4），
	// 而等待者排在其他应用的队列里 ⇒ 必须跨应用唤醒，否则会出现
	// "用户在自己占满 4 个全局槽后，其第 5 个应用的排队请求永远不会被唤醒"。
	s.pumpAllLocked()
	// 唤醒之后再回收本应用的条目：此时它既没在跑也没等待者 ⇒ 不需要留在表里
	// （审计 P2-3：条目只增不减会让"历史应用数"变成每次准入的固定成本）。
	s.dropIfIdleLocked(appID, as)
}

// pumpAllLocked 遍历**活跃**应用（在跑或有等待者）并授权。
//
// 为什么只遍历活跃集合（审计 P2-3）：此前遍历整个 `s.apps`，而它的条目只增不减
// ⇒ 每次 Release 的成本与"历史上出现过的应用数"成正比（20000 应用时单次
// Acquire+Release 516–811 µs，且全程持全局锁 = 全平台准入吞吐的天花板）。
// 现在成本只与活跃应用数成正比（全局在跑 ≤32、等待者所属应用数有界）。
//
// 跨应用顺序不保证公平（Go map 迭代顺序随机）：这是有意的 —— 每个应用最多占用
// PerAppRunning 个全局槽（默认 4 / 全局 32），不存在"某个应用把全局槽吃光"的
// 饿死路径（运营把 app_running 调到与 max_instances 同值时会失去这条性质，
// 需要自己承担）。而**应用内**的 FIFO 顺序由 pumpAppLocked 保证（§4.6 未要求跨应用公平）。
func (s *Scheduler) pumpAllLocked() {
	for appID := range s.active {
		s.pumpScans++ // 性能回归口径：只统计真的被遍历到的活跃条目
		as, ok := s.apps[appID]
		if !ok || len(as.waiters) == 0 {
			continue
		}
		s.pumpAppLocked(appID, as)
	}
}

// pumpAppLocked 按 FIFO 顺序授权某应用中所有当前可运行者
// （跳过会突破上限的，保留在队列中，不丢不报错）。
func (s *Scheduler) pumpAppLocked(appID string, as *appState) {
	// 唤醒也要按**本应用的生效上限**：否则"给 A 设 app_running=1"之后，
	// 一次 Release 仍会按全局 4 继续放行 A 的等待者（覆盖只在快路径生效）。
	eff := s.effectiveOptionsLocked(appID)
	for as.running < eff.PerAppRunning {
		idx := -1
		for i, w := range as.waiters {
			if w.granted {
				continue
			}
			if s.globalRunning >= s.opt.GlobalRunning {
				return
			}
			if w.userID != 0 {
				if s.userRunning[w.userID] >= s.opt.PerUserGlobalRunning {
					continue // 跳过（不阻塞后面的请求）
				}
				if as.userRunningOf(w.userID) >= eff.PerUserPerAppRunning {
					continue
				}
			}
			idx = i
			break
		}
		if idx < 0 {
			return
		}
		w := as.waiters[idx]
		// 从等待列表移除 + 记账。
		as.waiters = append(as.waiters[:idx], as.waiters[idx+1:]...)
		if w.userID != 0 {
			if as.userQueued[w.userID] > 1 {
				as.userQueued[w.userID]--
			} else {
				delete(as.userQueued, w.userID)
			}
		}
		s.waiting--
		// 离队 ⇒ 归还它占的排队体额度（**必须在 close(w.ch) 之前**：
		// 等待方被唤醒后就继续跑，之后再也拿不到这把锁；先归还再唤醒，
		// "此刻的排队体字节"才对得上"此刻还在等的人"）。
		s.refundQueuedBodyLocked(as, w)
		w.granted = true
		s.grantLocked(appID, w.userID)
		close(w.ch)
	}
}

// removeWaiterLocked 把仍在队列中的等待者摘除并归还其占位计数。
// 调用方必须持锁，且必须先确认 w.granted == false。
func (s *Scheduler) removeWaiterLocked(appID string, w *waiter) {
	as := s.appLocked(appID)
	for i, x := range as.waiters {
		if x == w {
			as.waiters = append(as.waiters[:i], as.waiters[i+1:]...)
			if w.userID != 0 {
				if as.userQueued[w.userID] > 1 {
					as.userQueued[w.userID]--
				} else {
					delete(as.userQueued, w.userID)
				}
			}
			s.waiting--
			// 超时/取消离队：归还排队体额度（与授权路径同一份归还实现，
			// 保证"授权 / 超时 / 被拒"三条路径都不会漏账）。
			s.refundQueuedBodyLocked(as, w)
			s.dropIfIdleLocked(appID, as)
			return
		}
	}
}

// ===== 排队请求体字节记账（P1-3）=====
//
// 一对唯一的加减实现：任何"入队/离队"都必须经它们（不要在别处直接改
// s.queuedBodyBytes 或 as.queuedBytes —— 两处各算一份就会出现"全局账平了、
// 按应用的账没平"或反过来）。
//
// 不变量（由 queue_bodybudget_test.go 逐操作断言）：
//  1. s.queuedBodyBytes == Σ as.queuedBytes（活跃应用）；
//  2. s.queuedBodyBytes == Σ 在队 waiter.bodyBytes；
//  3. s.queuedBodyBytes ≤ s.opt.QueueBodyBytes（除非 SetOptions 之后预算被调小：
//     那种情况下**不驱逐**已在队的等待者，只让新的准入 fail-closed，直到排空）。

// chargeQueuedBodyLocked 为刚入队的等待者占账。调用方必须持锁。
func (s *Scheduler) chargeQueuedBodyLocked(as *appState, w *waiter, bodyBytes int64) {
	w.bodyBytes = bodyBytes
	if bodyBytes <= 0 {
		return
	}
	s.queuedBodyBytes += bodyBytes
	if as != nil {
		as.queuedBytes += bodyBytes
	}
	if s.queuedBodyBytes > s.maxQueuedBodyBytes {
		s.maxQueuedBodyBytes = s.queuedBodyBytes
	}
}

// refundQueuedBodyLocked 归还某等待者占的额度（幂等：归还后 w.bodyBytes 置 0）。
// 调用方必须持锁。
func (s *Scheduler) refundQueuedBodyLocked(as *appState, w *waiter) {
	if w == nil {
		return
	}
	n := w.bodyBytes
	if n <= 0 {
		return
	}
	w.bodyBytes = 0
	// 下限夹到 0 是**防御**而不是语义：计数一旦变成负数，"预算已满"就会永久误判
	// （账面上没内存可用、实际队列是空的），比 OOM 更难查。真的漂移由上文的
	// 不变量用例在测试里抓，不在运行期静默补偿之外再做任何事。
	if s.queuedBodyBytes >= n {
		s.queuedBodyBytes -= n
	} else {
		s.queuedBodyBytes = 0
	}
	if as != nil {
		if as.queuedBytes >= n {
			as.queuedBytes -= n
		} else {
			as.queuedBytes = 0
		}
	}
}

// fmtBytes 把字节数渲染成人能读的 MiB/KiB（只用于 hint 文案）。
//
// 不复用人类格式化库：这里的消费者是**错误提示**，要短、要稳定、不要语言环境差异。
func fmtBytes(n int64) string {
	if n <= 0 {
		return "0"
	}
	if n%(1<<20) == 0 {
		return fmt.Sprintf("%d MiB", n>>20)
	}
	if n < 1<<20 {
		return fmt.Sprintf("%d KiB", n>>10)
	}
	return fmt.Sprintf("%.1f MiB", float64(n)/float64(1<<20))
}

// dropIfIdleLocked 回收"既没在跑也没有等待者"的应用条目（调用方必须持锁）。
//
// 这张表以前只增不减：应用被删、长期没请求都不会回收，于是每次 Release 的全表遍历
// 成本随历史应用数线性增长（审计 P2-3）。条目本身不是资源泄漏（一个空
// appState 只有几十字节），但它是**准入吞吐的分母**，所以必须与"活跃"同义。
//
// 不变量（由 TestIdleAppsAreReclaimed 断言）：任何对外操作返回后，
// `s.apps` 里的每个条目都在 `s.active` 里（在跑或有等待者）。
func (s *Scheduler) dropIfIdleLocked(appID string, as *appState) {
	if as == nil || as.running > 0 || len(as.waiters) > 0 {
		return
	}
	delete(s.apps, appID)
	delete(s.active, appID)
}

func (s *Scheduler) appLocked(appID string) *appState {
	as, ok := s.apps[appID]
	if !ok {
		as = &appState{userQueued: map[int64]int{}, runningUsers: map[int64]int{}}
		s.apps[appID] = as
	}
	return as
}

// Stats 返回全局水位。
func (s *Scheduler) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	// 只遍历活跃集合（有界）：Stats 会被 /readyz 反复调用，不能退回全表扫描。
	n := 0
	for appID := range s.active {
		if as, ok := s.apps[appID]; ok && len(as.waiters) > 0 {
			n++
		}
	}
	return Stats{
		GlobalRunning:       s.globalRunning,
		Waiting:             s.waiting,
		Apps:                n,
		TrackedApps:         len(s.apps),
		RejectedQueueFull:   s.rejectedQueueFull,
		RejectedWallClock:   s.rejectedWallClock,
		RejectedQueueBytes:  s.rejectedQueueBytes,
		QueuedBodyBytes:     s.queuedBodyBytes,
		MaxQueuedBodyBytes:  s.maxQueuedBodyBytes,
		QueueBodyBytesLimit: s.opt.QueueBodyBytes,
	}
}

// PumpScans 返回 pumpAllLocked 累计遍历的应用条目数（**性能回归口径**）。
//
// 存在的意义：性能判据用"遍历次数"而不是绝对耗时（机器差异会让绝对阈值假红）。
// 判据是"单次 Acquire+Release 的遍历次数不随历史应用数增长"。
func (s *Scheduler) PumpScans() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pumpScans
}

// AppStats 返回某应用的水位（诊断用）。
func (s *Scheduler) AppStats(appID string) (running, waiting int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if as, ok := s.apps[appID]; ok {
		return as.running, len(as.waiters)
	}
	return 0, 0
}

// Options 返回本调度器生效的上限（测试与文档断言用）。
func (s *Scheduler) Options() Options {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.opt
}

// SetOptions 热替换调度上限（控制台保存后即时生效）。
//
// 为什么允许运行期改：并发上限是**运营参数**（机器大小/应用数量变了就要调），
// 而 Scheduler 的全部判定都在 s.mu 下读 s.opt —— 换掉这一份并立刻 pump 一次，
// 新上限对在途与后续请求同时生效（收紧时不会打断已在跑的请求，只影响新的准入）。
func (s *Scheduler) SetOptions(opt Options) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.opt = opt.withDefaults()
	s.pumpAllLocked()
	s.mu.Unlock()
}

// ---- 应用级限流覆盖（决策 docs/decisions/2026-10-22-wasm-per-app-limits.md §2.2）----
//
// 真源是 PG 的 `wasm_app_limits`（迁移 0087）；本文件只持有**内存镜像**，
// 由装配层在启动期装载一次、在管理 API 保存时增量更新（落库 → 更新本表 → 审计）。
//
// 生效面**只有四个轴**：PerAppRunning / PerAppQueue / PerUserPerAppRunning /
// PerUserPerAppQueued。GlobalRunning（全局实例上限）、PerUserGlobalRunning（单用户跨应用）
// 与 WallClock（端到端墙钟）恒用全局值 —— 它们不是"某个应用"的属性，per-app 覆盖它们
// 会让"全局保护"按应用分叉（决策 §2.2「其余字段仍用全局」）。

// effectiveOptionsLocked 返回某应用的**生效上限**（调用方必须持锁）。
//
// 唯一的取值点：快路径（canRunLocked）、队列容量检查（Acquire）、唤醒（pumpAppLocked）
// 三处都读它 —— 任何一处改回 `s.opt` 都会让覆盖只在部分路径生效（决策 §2.6 第 4 条的
// 变异判据就是这样打红的）。
//
// 0 值语义与 limits.AppOverride 一致：0 = 该轴继承全局（这里再做一次 `> 0` 判断是
// **防御**：装配层保证不把全 0 存进来，但"直接订阅 map"的测试/未来调用方可能绕过它）。
func (s *Scheduler) effectiveOptionsLocked(appID string) Options {
	eff := s.opt
	ov, ok := s.appOverrides[appID]
	if !ok || ov.IsZero() {
		return eff
	}
	// 套用规则的**唯一实现**在 limits.Axes.Resolve（与 applimits.ApplyOverride /
	// 管理端视图的 effective 同一份）：非 0 覆盖直接生效；继承的子轴在父轴被收紧时
	// 向下钳（`app_running=1` ⇒ 继承来的 `user_per_app_running=2` 也变成 1）。
	axes := limits.Axes{
		AppRunning:        eff.PerAppRunning,
		AppQueue:          eff.PerAppQueue,
		UserPerAppRunning: eff.PerUserPerAppRunning,
		UserPerAppQueued:  eff.PerUserPerAppQueued,
	}.Resolve(ov)
	eff.PerAppRunning = axes.AppRunning
	eff.PerAppQueue = axes.AppQueue
	eff.PerUserPerAppRunning = axes.UserPerAppRunning
	eff.PerUserPerAppQueued = axes.UserPerAppQueued
	return eff
}

// EffectiveOptions 返回某应用此刻的生效上限（诊断/测试用；无需持锁）。
//
// 与 Options() 的关系：Options() 是**全局**值，本函数是"某个应用实际按什么判"。
// 管理端视图里的 `effective` 由同一份规则（applimits.ApplyOverride）算出，
// 两处不会分叉 —— 覆盖的四轴只有这一种套用方式。
func (s *Scheduler) EffectiveOptions(appID string) Options {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.effectiveOptionsLocked(appID)
}

// AppLimitOverride 返回某应用当前的覆盖（无覆盖时 ok=false）。
//
// 读面存在是为了让"清空覆盖后内存表里那条真的没了"可断言 —— 只测"准入行为回到全局"
// 分不清"覆盖被正确删除"与"覆盖还在、只是恰好没触发"。
func (s *Scheduler) AppLimitOverride(appID string) (limits.AppOverride, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ov, ok := s.appOverrides[appID]
	if !ok || ov.IsZero() {
		return limits.AppOverride{}, false
	}
	return ov, true
}

// SetAppLimitOverride 设置/清空某应用的四轴覆盖（nil 或零值 = 清空）。
//
// 语义（决策 §2.4）：
//   - **即时生效**：新准入立刻按新值判定；
//   - **收紧不打断在跑**：本函数只改上限表，不动任何在跑请求的记账；
//   - 收紧后**已在队列里的等待者不丢**：它们继续按 FIFO 等待，直到有槽（被唤醒）
//     或撞上端到端墙钟 —— 后者就是现有的 APP_QUEUE_FULL(429, reason=wall_clock_exceeded)
//     语义，不新增"静默丢弃"分支；
//   - **放宽立刻唤醒**：改宽之后调一次 pumpAllLocked，否则被全局值挡住的等待者
//     要等下一次 Release 才可能被唤醒（运维看到的是"改了没反应"）。
func (s *Scheduler) SetAppLimitOverride(appID string, ov limits.AppOverride) {
	if s == nil {
		return
	}
	appID = strings.TrimSpace(appID)
	if appID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	if ov.IsZero() {
		if _, ok := s.appOverrides[appID]; ok {
			delete(s.appOverrides, appID)
			changed = true
		}
	} else {
		cur, ok := s.appOverrides[appID]
		if !ok || !cur.Equal(ov) {
			if s.appOverrides == nil {
				s.appOverrides = map[string]limits.AppOverride{}
			}
			s.appOverrides[appID] = ov
			changed = true
		}
	}
	if !changed {
		return
	}
	s.pumpAllLocked()
}

// SetAppLimitOverrides **整表替换**覆盖（启动期装载用）。
//
// 为什么是替换而不是合并：它服务"进程启动时从库读全量"这一条路径，合并语义会让
// "库里删掉的覆盖"在重启后继续留在内存里（残留覆盖 = 管理员清不掉的黑配置）。
// 零值/空 app_id 的条目被**跳过**（归一化与 SetAppLimitOverride 同一条判据）。
func (s *Scheduler) SetAppLimitOverrides(overrides map[string]limits.AppOverride) {
	if s == nil {
		return
	}
	next := make(map[string]limits.AppOverride, len(overrides))
	for appID, ov := range overrides {
		appID = strings.TrimSpace(appID)
		if appID == "" || ov.IsZero() {
			continue
		}
		next[appID] = ov
	}
	s.mu.Lock()
	s.appOverrides = next
	s.pumpAllLocked()
	s.mu.Unlock()
}

// AppLimitOverrideCount 返回当前持有覆盖的应用数（只读；运维面/测试用）。
func (s *Scheduler) AppLimitOverrideCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.appOverrides)
}

// AppWatermark 是单个应用队列水位（管理面"哪个应用在拖垮平台"的读数）。
type AppWatermark struct {
	AppID   string `json:"app_id"`
	Running int    `json:"running"`
	Waiting int    `json:"waiting"`
	// Rejected 是该应用累计被 429 拒绝的次数（队列满 + 用户占位满 + 排队体预算满 + 墙钟）。
	Rejected int64 `json:"rejected"`
	// QueuedBodyBytes 是该应用**此刻**在队请求已读入内存的请求体字节合计（P1-3）。
	//
	// 单独下发它的理由：全局 queued_body_bytes 只说"平台还剩多少预算"，
	// 回答不了"是哪个应用把它吃掉的"——而那正是运维要处置的对象
	//（限流覆盖 / 让发布者拆小请求 / 扩容）。
	QueuedBodyBytes int64 `json:"queued_body_bytes"`
}

// AppWatermarks 返回按"在跑+等待"降序的前 limit 个应用水位（有界：只遍历活跃+拒绝表）。
//
// 为什么要有界：管理面 /admin/runtime 会被反复轮询，不能退回全表扫描；
// 同时"当前在跑/等待"只存在于 appState（空闲即回收），拒绝计数是可选的补充。
func (s *Scheduler) AppWatermarks(limit int) []AppWatermark {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]AppWatermark, 0, len(s.apps))
	seen := make(map[string]bool, len(s.apps))
	for appID, as := range s.apps {
		if as.running == 0 && len(as.waiters) == 0 {
			continue
		}
		out = append(out, AppWatermark{AppID: appID, Running: as.running, Waiting: len(as.waiters),
			Rejected: s.rejectedByApp[appID], QueuedBodyBytes: as.queuedBytes})
		seen[appID] = true
	}
	for appID, n := range s.rejectedByApp {
		if seen[appID] {
			continue
		}
		out = append(out, AppWatermark{AppID: appID, Rejected: n})
	}
	sort.Slice(out, func(i, j int) bool {
		wi, wj := out[i].Running+out[i].Waiting, out[j].Running+out[j].Waiting
		if wi != wj {
			return wi > wj
		}
		if out[i].Rejected != out[j].Rejected {
			return out[i].Rejected > out[j].Rejected
		}
		return out[i].AppID < out[j].AppID
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}
