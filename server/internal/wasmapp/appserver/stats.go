package appserver

import "time"

// 运行期**水位出口**（C-10，审计 2026-10-22）。
//
// 现场：限额控制台可以调 `module_cache_mb` / `app_db_readers` / `app_db_idle_min`，
// 但运行期**没有任何出口**能回答"现在真的用了多少" —— 管理面 `/admin/wasm-apps/runtime`
// 把这两项归进 `unavailable`（代码自认没有访问器），管理员于是只能在"改大一点试试"
// 与"看容器 RSS"之间猜。审计 C-10 原话："控制台可调 module_cache_mb / app_db_readers，
// 但运行期没有水位出口（代码自认 unavailable）"。
//
// 本文件只做**只读投影**：数值全部来自既有组件自己的记账（moduleCache.size/bounds、
// appDBPool.size/Limits/Readers），不在这里重算任何上限，也不缓存 —— 缓存会让
// "缓存已经空了但状态表还是上次的值"这种要和审计对着干的形态出现。
//
// 两个方法都 nil-safe（Server 指针或内部组件为 nil 时返回零值结构）：装配期
// （构造失败/最小装配）与 Close 之后的读路径都不该 panic。

// ModuleCacheStats 是进程内模块缓存的**当前**占用（条目/记账字节/已编译条目 + 上限）。
//
// `Bytes` 是 moduleCache 自己的记账口径（随包资源字节 + 编译产物估算 ≈ 4× 原始字节，
// 见 modules.go 的 compiledModuleSizeFactor）：它不是 RSS，不能拿它当"内存占用"对账；
// 它的用途是回答"这个缓存离上限还有多远"。
type ModuleCacheStats struct {
	// Entries 是缓存条目数（含"只有资源、还没编译"的条目）。
	Entries int
	// CompiledEntries 是已编译（mod 就绪）的条目数；<= Entries。
	CompiledEntries int
	// Bytes 是记账占用的字节数（资源集 + 编译产物估算）。
	Bytes int64
	// MaxBytes / MaxEntries 是**当前生效**的上限（控制台保存后热替换，见 SetBounds）。
	MaxBytes   int64
	MaxEntries int
	// IdleTTL 是空闲淘汰阈值（0 = 只按容量淘汰）。
	IdleTTL time.Duration
}

// AppDBPoolStats 是应用库句柄池的当前占用。
//
// `Handles` 是池里**同时持有**的句柄数（每句柄 1 写 + N 读连接），
// `Max` 是当前生效的上限（控制台 `app_db_handles`/部署档位注入），
// `Readers` 是"下一个新建句柄"将使用的只读连接数（已有句柄建连时的值没有被记账 ——
// 要看连接实数应看 /proc/self/fd，见 dbpool.Readers 的注释）。
type AppDBPoolStats struct {
	Handles int
	Max     int
	Readers int
	// IdleTimeout 是当前生效的空闲回收阈值。
	IdleTimeout time.Duration
}

// ModuleCacheStats 返回模块缓存的当前占用（C-10 的只读出口）。
func (s *Server) ModuleCacheStats() ModuleCacheStats {
	if s == nil || s.modules == nil {
		return ModuleCacheStats{}
	}
	entries, bytes := s.modules.size()
	maxBytes, maxEntries, idleTTL := s.modules.bounds()
	return ModuleCacheStats{
		Entries:         entries,
		CompiledEntries: s.modules.compiledCount(),
		Bytes:           bytes,
		MaxBytes:        maxBytes,
		MaxEntries:      maxEntries,
		IdleTTL:         idleTTL,
	}
}

// AppDBPoolStats 返回应用库句柄池的当前占用（C-10 的只读出口）。
func (s *Server) AppDBPoolStats() AppDBPoolStats {
	if s == nil || s.appdbs == nil {
		return AppDBPoolStats{}
	}
	maxHandles, idle := s.appdbs.Limits()
	return AppDBPoolStats{
		Handles:     s.appdbs.size(),
		Max:         maxHandles,
		Readers:     s.appdbs.Readers(),
		IdleTimeout: idle,
	}
}
