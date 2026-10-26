// Package serverstore — 统一应用模型 DAO(迁移 0053/0054)。
//
// 决策 docs/decisions/2026-09-01-skill-app-management.md P2:技能与智能体
// 统一为 App(长期身份)+ Release(不可变版本快照)。本文件是该模型的唯一
// 数据访问层——旧的 skills/shared_skills/agent_presets DAO 在兼容期内保留
// 只读,新写入一律走这里。
package serverstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// App 分发渠道与内容类型的合法取值。
const (
	AppChannelMarket = "market"
	AppChannelOrg    = "org"
	AppKindSkill     = "skill"
	AppKindAgent     = "agent"
)

// Release 审核状态(与旧三表一致,迁移不改变审核语义)。
const (
	ReleaseStatusPending  = "pending"
	ReleaseStatusApproved = "approved"
	ReleaseStatusRejected = "rejected"
)

// App 是一个能力的长期身份:名字、归属、渠道、上下架状态与授权都挂在它上面。
type App struct {
	Kind        string
	AppID       string
	Title       string
	Description string
	Owner       string
	Channel     string
	Enabled     int
	// Official 官方属性(0059, App 级): 1=归属官方(蓝标/仅管理员可上传),
	// 此时 Owner 为 ''(无个人归属)。
	Official  int
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Release 是一次不可变的版本快照。内容字段一经写入不再更新,只有审核状态、
// 质量标记、下载计数与软删标记可变。
type Release struct {
	ID          int64
	Kind        string
	AppID       string
	Version     string
	Title       string
	Description string
	Changelog   string
	Category    string
	Tags        []string
	Author      string // 包内署名
	Publisher   string // 发布账号(登录态,不可伪造)
	Checksum    string
	Size        int64
	Archive     []byte
	Status      string
	Reason      string
	Quality     string
	Downloads   int64
	Calls       int64
	DeletedAt   *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

const appColumns = "kind, app_id, title, description, owner, channel, enabled, official, created_at, updated_at"

// releaseListColumns 不含 archive blob:清单查询绝不加载全部归档。
const releaseListColumns = "id, kind, app_id, version, title, description, changelog, category, tags, " +
	"author, publisher, checksum, size, status, reason, quality, downloads, calls, deleted_at, created_at, updated_at"

const releaseFullColumns = "id, kind, app_id, version, title, description, changelog, category, tags, " +
	"author, publisher, checksum, size, status, reason, quality, downloads, calls, deleted_at, created_at, updated_at, archive"

func scanApp(row interface{ Scan(...any) error }) (*App, error) {
	var a App
	var created, updated any
	if err := row.Scan(&a.Kind, &a.AppID, &a.Title, &a.Description, &a.Owner, &a.Channel,
		&a.Enabled, &a.Official, &created, &updated); err != nil {
		return nil, err
	}
	a.CreatedAt, a.UpdatedAt = parseSQLTime(created), parseSQLTime(updated)
	return &a, nil
}

func scanRelease(row interface{ Scan(...any) error }, withArchive bool) (*Release, error) {
	var r Release
	var tags string
	var deleted, created, updated any
	dest := []any{&r.ID, &r.Kind, &r.AppID, &r.Version, &r.Title, &r.Description, &r.Changelog,
		&r.Category, &tags, &r.Author, &r.Publisher, &r.Checksum, &r.Size, &r.Status, &r.Reason,
		&r.Quality, &r.Downloads, &r.Calls, &deleted, &created, &updated}
	if withArchive {
		dest = append(dest, &r.Archive)
	}
	if err := row.Scan(dest...); err != nil {
		return nil, err
	}
	if tags != "" {
		_ = json.Unmarshal([]byte(tags), &r.Tags)
	}
	if deleted != nil {
		t := parseSQLTime(deleted)
		r.DeletedAt = &t
	}
	r.CreatedAt, r.UpdatedAt = parseSQLTime(created), parseSQLTime(updated)
	return &r, nil
}

// UpsertApp 建立或更新一个 App 身份(幂等)。渠道一经确定不再变更——跨渠道
// 迁移属于人工决策,不应由一次发布静默改写。
//
// 冲突分支带**官方归属守卫**(`official=1 ⇒ owner=”`,R15C-G-04):与 wasm 面的
// UpsertWasmApp 逐字同形,理由见 upsertApp 的注释。
func UpsertApp(db *sql.DB, a *App) error {
	return upsertApp(db, a)
}

// RecomputeAppProjection 把 apps 行的**展示投影列**(title/description)重算为
// "最新 approved 版本"的值,返回生效版本号(没有任何 approved 版本时返回 "")。
//
// 为什么必须有这一步(审计 2026-09-23 G-P2-3):apps 行是**目录对全员下发的
// 投影**(技能/智能体/应用共用同一张表),而 app_releases 才是真相。发布内核
// 只保证"待审版本不提前投影"(见 appstore.Publish 的 pending 分支),审核落定
// 之后还必须把投影**切到**生效版本:
//
//   - approve:新版本成为生效版本 ⇒ 投影切到它(漏掉这一步 = "批准了却永远
//     看不到新标题");
//   - reject :被拒版本从未生效 ⇒ 投影**恢复**成仍在生效的那一版(漏掉这一步 =
//     被拒/被撤回的标题永久留在目录上,而且没有任何自愈路径 —— 必须等下一次
//     approved 发布才会被覆盖)。
//
// 取最高 approved 而不是"本次审核的版本":审批一个更旧的待审版本时(v2 待审、
// v3 已通过),生效版本仍是更新的那个 —— 与线上交付(max(id) approved)同口径。
//
// 没有任何 approved 版本(首版待审被拒)时回落到 **app_id 占位**:空标题不是
// 可接受的终态(目录/详情/导出都直接读这一列),而 app_id 至少是可识别、可定位
// 的占位值 —— 与发布期首版待审的占位口径一致。
//
// **幂等且最小写入**:值没变就不写(updated_at 不跳),因此重复调用能自愈脏行、
// 且第二次调用零副作用。
//
// 2026-09-25(R15C-G-02):整个"读最高 approved 版本 → 写投影"必须收在**同一个事务 +
// apps 行锁**里。旧实现是 autocommit 下的两条语句,两个管理员并发审批两个待审版本
// 时会丢更新:后写者用自己那一刻读到的**陈旧快照**覆盖先写者,终态是
// `app_releases` 里最高 approved 已是 v3、而 `apps.title/description` 停在 v1 ——
// 目录、详情、导出都读 apps 行,于是**全组织看到的标题属于一个已经过期的版本**,
// 而且此后没有任何路径会修回来(发布内核的 pending 分支刻意"投影一字不动",
// 只有下一次 approve/reject 才会再走到这里)。
//
// 为什么是"先锁 apps 行、再读版本",而不是把判定推进 UPDATE 的子查询:后者只保证
// 写入值与**该语句的**快照一致,返回值(调用方要的"生效版本号")仍来自另一条
// 陈旧读;而行锁把"读版本快照"与"写投影"绑成一个串行单元 —— 与 serverstore 既有
// 的读-改-写范式一致(见 users.go 的 FOR UPDATE 与 gateway.go 的同款注释)。
// 锁粒度选 apps 行:投影的唯一写入口就是这里,而它写的正是这一行;锁 release 行
// 既锁不住"另一个版本被 approve",又会与发布路径(apps 行 → app_releases)反序死锁。
func RecomputeAppProjection(db *sql.DB, kind, appID string) (string, error) {
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback() //nolint:errcheck // Commit 之后是 no-op
	// 行不存在时 `FOR UPDATE` 锁不到东西(也不报错):此时下面的 UPDATE 同样是 0 行,
	// 与旧实现"没有 apps 行"的语义逐字一致(返回值仍按版本表算)。
	var locked int
	if err := tx.QueryRow(`SELECT 1 FROM apps WHERE kind = ? AND app_id = ? FOR UPDATE`,
		kind, appID).Scan(&locked); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	var version, title, description string
	// F-04(2026-10-26):投影必须与**交付**同一口径 —— 生效版本 = 版本号最大的
	// approved 版本,由 PickCurrentRelease 唯一判定。此前这里写的是
	// `ORDER BY id DESC LIMIT 1`:版本号乱序批准时(先批准 v2.0.0、后批准补发的
	// v1.9.0),投影取 id 更大的 v1.9.0 而下载面取 semver 最大的 v2.0.0 ——
	// 目录标题/描述与员工实际装到的内容分叉,且没有自愈路径。
	//
	// 取数走 ListReleasesOn/PickCurrentRelease(与 currentRelease 同一实现),
	// 不在这里重写第二条比较规则:两份判据就是下一次漂移的落点。
	releases, lerr := ListReleasesOn(tx, kind, appID)
	if lerr != nil {
		return "", lerr
	}
	if best := PickCurrentRelease(releases); best != nil {
		version, title, description = best.Version, best.Title, best.Description
	} else {
		version, title, description = "", appID, ""
	}
	if _, err := tx.Exec(`UPDATE apps SET title = ?, description = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND (title <> ? OR description <> ?)`,
		title, description, kind, appID, title, description); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return version, nil
}

// 硬删「空壳 App」的错误语义(F-02,能力中心审计 2026-10-26)。
//
// 背景:管理端「新建」只登记 App 身份(POST /skills、POST /agents),
// 内容另一步上传;打错名字/放弃后,**没有任何路径**能把这一行删掉 ——
// 名称被永久占用且跨渠道互斥(市场占名同时挡组织同名),只能改库。
//
// 安全边界(产品语义,不是调用方礼貌):只有**从未生效**的空壳才可以硬删 ——
// 存在任何未软删版本(含 pending/approved)时必须先正常处理(下架/删除版本),
// 官方归属的内容不允许释放(蓝标内容的身份归平台,删掉等于静默下架)。
var (
	// ErrAppHasReleases:该 App 仍有未软删版本 ⇒ 不是空壳。
	ErrAppHasReleases = errors.New("app still has releases")
	// ErrAppOfficial:官方归属的 App 不可硬删。
	ErrAppOfficial = errors.New("official app cannot be deleted")
)

// DeleteEmptyApp 硬删一个**空壳** App(释放被占用的名称),并清理其授权。
//
// 允许条件(全部满足):kind ∈ {skill, agent};App 存在;没有未软删版本;
// 非官方归属。任何一条不满足都返回 sentinel(调用方映射 404/409/400)。
//
// 事务内 `SELECT ... FOR UPDATE` 锁住 apps 行后再数版本:与发布内核的
// 「占名 + 建版本」在同一事务里完成不同,这里的读-删必须原子 —— 否则
// "判定为空壳"与"另一路径刚好发布了首版"会交错,把刚发布的内容连行删掉。
//
// 为什么连同软删版本墓碑一起消失:app_releases 对 apps 有 `ON DELETE CASCADE`,
// 软删行的 archive 早已置 NULL、且不在任何读面出现;硬删释放名称时按唯一
// 约束连墓碑一起清掉(版本号因此可被同名新 App 重新使用 —— 这正是"释放名称"
// 的产品含义,被软删版本的版本号不再有意义)。仍需要历史时用审计日志追溯。
func DeleteEmptyApp(db *sql.DB, kind, appID string) error {
	if kind != AppKindSkill && kind != AppKindAgent {
		// WASM 应用有独立的生命周期(purge 两阶段 + 数据清理),不走本入口。
		return ErrValidation
	}
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // Commit 之后是 no-op
	var official int
	err = tx.QueryRow(`SELECT official FROM apps WHERE kind = ? AND app_id = ? FOR UPDATE`,
		kind, appID).Scan(&official)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var active int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM app_releases
		WHERE kind = ? AND app_id = ? AND deleted_at IS NULL`, kind, appID).Scan(&active); err != nil {
		return err
	}
	if active > 0 {
		return ErrAppHasReleases
	}
	if official == 1 {
		return ErrAppOfficial
	}
	// 授权按 (kind, app_id) 存活;名称释放后旧授权不得"复活"到同名新内容上。
	if _, err := tx.Exec(`DELETE FROM app_grants WHERE kind = ? AND app_id = ?`, kind, appID); err != nil {
		return err
	}
	res, err := tx.Exec(`DELETE FROM apps WHERE kind = ? AND app_id = ?`, kind, appID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

// upsertApp 是 UpsertApp 的 executor 版本(可传入 *sql.Tx,供原子发布复用)。
//
// **官方归属守卫**(R15C-G-04,与 UpsertWasmApp 的 R3-A A-9 逐字同形):
// `official=1 ⇒ owner=”` 是迁移 0059/P2-21 的不变量,`SetAppOfficial` 对
// "official=1 ∧ owner≠”"直接返回 ErrValidation。而本函数的 COALESCE 分支恰好能
// 造出那个禁止状态:官方行的 owner 本来就是空串,于是
// `COALESCE(NULLIF(”,”), excluded.owner)` 把归属填成发布者、official 仍是 1 ——
// 聚合面随后把这条官方内容当成"某人的应用"(is_owner 为真而发布仍被拒)。
//
// 两个孪生 upsert 曾经只有 wasm 那一侧有守卫,技能/智能体这一侧没有 ——
// 与 A-9 同一条纪律:**不变量必须在唯一写入口成立,与调用点无关**
// (调用点今天恰好传了现值不构成防线;`marketplace/agent_api.go` 的
// createAgentAdmin 就是先查后 upsert 的冲突分支)。
func upsertApp(ex queryer, a *App) error {
	if a.Kind != AppKindSkill && a.Kind != AppKindAgent {
		return errors.New("invalid app kind")
	}
	if a.Channel != AppChannelMarket && a.Channel != AppChannelOrg {
		return errors.New("invalid app channel")
	}
	_, err := ex.Exec(`INSERT INTO apps (kind, app_id, title, description, owner, channel, enabled)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (kind, app_id) DO UPDATE SET
			title = excluded.title, description = excluded.description,
			owner = CASE WHEN apps.official = 1 THEN ''
				ELSE COALESCE(NULLIF(apps.owner, ''), excluded.owner) END,
			updated_at = `+NowExpr(),
		a.Kind, a.AppID, a.Title, a.Description, a.Owner, a.Channel, a.Enabled)
	return err
}

// Queryer 是 *sql.DB / *sql.Tx / *sql.Conn 的公共子集(groups.go 的内部
// queryer 只含 QueryRow/Exec,这里因为要读版本清单,把 Query 一并列出)。
//
// 2026-09-13(N-2):发布路径必须把咨询锁与全部读写放在**同一条连接**上 ——
// 「持锁连接 + 干活连接」的方案在连接需求 > 池上限时会死锁,而不同名并发
// 上传在生产里是正常负载。因此这些 DAO 需要「在调用方给定的事务里执行」
// 的变体(后缀 On)。
type Queryer interface {
	QueryRow(query string, args ...any) *sql.Row
	Query(query string, args ...any) (*sql.Rows, error)
	Exec(query string, args ...any) (sql.Result, error)
}

// GetAppOn 是 GetApp 的 executor 版本(可在 *sql.Tx 上执行)。
func GetAppOn(ex Queryer, kind, appID string) (*App, error) {
	a, err := scanApp(ex.QueryRow(`SELECT `+appColumns+` FROM apps WHERE kind = ? AND app_id = ?`, kind, appID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return a, err
}

// ListReleasesOn 是 ListReleases 的 executor 版本(可在 *sql.Tx 上执行)。
func ListReleasesOn(ex Queryer, kind, appID string) ([]Release, error) {
	rows, err := ex.Query(`SELECT `+releaseListColumns+` FROM app_releases
		WHERE kind = ? AND app_id = ? ORDER BY created_at`, kind, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectReleases(rows)
}

// PendingReleaseCountOn 是 PendingReleaseCount 的 executor 版本。
func PendingReleaseCountOn(ex Queryer, publisher string) (int, error) {
	var n int
	err := ex.QueryRow(`SELECT count(*) FROM app_releases
		WHERE publisher = ? AND status = 'pending' AND deleted_at IS NULL`, publisher).Scan(&n)
	return n, err
}

// UpsertAppAndCreateReleaseOn 在**调用方提供的事务**里完成「占名 + 建版本」
// (N-2:发布锁已在该事务上,落库不能再开第二条连接)。调用方负责 Commit;
// 任一步失败由调用方 Rollback,原子性与 UpsertAppAndCreateRelease 相同。
func UpsertAppAndCreateReleaseOn(ex Queryer, a *App, r *Release) (int64, error) {
	if err := upsertApp(ex, a); err != nil {
		return 0, err
	}
	return createRelease(ex, r)
}

// GetApp 按 (kind, app_id) 取 App;不存在返回 ErrNotFound。
func GetApp(db *sql.DB, kind, appID string) (*App, error) {
	return GetAppOn(db, kind, appID)
}

// ListApps 列出全部 App(管理端视图),可按 kind/channel 过滤(空 = 不过滤)。
func ListApps(db *sql.DB, kind, channel string) ([]App, error) {
	q := `SELECT ` + appColumns + ` FROM apps WHERE 1=1`
	args := []any{}
	if kind != "" {
		q += ` AND kind = ?`
		args = append(args, kind)
	}
	if channel != "" {
		q += ` AND channel = ?`
		args = append(args, channel)
	}
	q += ` ORDER BY kind, app_id`
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []App{}
	for rows.Next() {
		a, err := scanApp(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// AppChannelMap 返回某 kind 的 appID → apps.channel 映射。
//
// 渠道的**唯一事实源是 apps 行**（app_releases 没有渠道列，0053）：任何需要
// 「按行渠道」做投影或过滤的读面都必须经这里建映射，不要另写一份
// `SELECT channel FROM apps`（2026-10-23 作者面全渠道化 C4 的唯一取数口）。
func AppChannelMap(db *sql.DB, kind string) (map[string]string, error) {
	apps, err := ListApps(db, kind, "")
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(apps))
	for _, a := range apps {
		out[a.AppID] = a.Channel
	}
	return out, nil
}

// AppChannelOf 返回单个 App 的渠道（行不存在 ⇒ ""）。
// 单行读取路径用它，避免为了一个渠道去扫全表（AppChannelMap 的批量版）。
func AppChannelOf(db *sql.DB, kind, appID string) string {
	a, err := GetApp(db, kind, appID)
	if err != nil {
		return ""
	}
	return a.Channel
}

// ReleaseRowsByChannel 过滤掉「没有 apps 行」的 release 悬挂行。
//
// 理论上有 (kind, app_id) → apps 的外键（0053）保证不会出现，但 0054 回填
// 期间与手工数据修复都可能留下孤儿；取数一旦把孤儿算进「我的」，归属判据
// 就失去事实源（DistributionMap 里不存在该 App ⇒ OwnedBy 恒 false，行会
// 无声消失）。这里显式剔除，与 orgSkillReleases 一直以来的「org 集合过滤」
// 同形。
func ReleaseRowsByChannel(all []Release, channels map[string]string) []Release {
	out := make([]Release, 0, len(all))
	for _, r := range all {
		if _, ok := channels[r.AppID]; ok {
			out = append(out, r)
		}
	}
	return out
}

// SetAppOfficial 设置 App 官方属性与归属(转官方=official=1+owner=”;
// 转用户=official=0+owner=<username>)。官方属性是 App 级唯一事实源,
// 不经 UpsertApp 泄露(发布/元数据更新不触碰本列)。
//
// **不变量守卫**(审计 2026-09-23 G-P2-1):官方归属的唯一合法形态是
// `official=1 ∧ owner 为空`(迁移 0059 / P2-21)。此前本函数接受任意组合,于是
// 任何一条"顺手也写 owner"的调用点都能造出 `official=1 ∧ owner 非空` ——
// 那会让 is_owner 对 owner 为 true(员工端显示「我的」)而发布仍被
// OFFICIAL_LOCKED 403 拒绝,客户端预检与服务端判定分叉。守卫放在这里,
// 未来的调用者无论怎么传都造不出禁止状态。
func SetAppOfficial(db *sql.DB, kind, appID string, official bool, owner string) error {
	if official && owner != "" {
		return fmt.Errorf("%w: 官方归属必须 owner 为空(official=1 ∧ owner 非空 是禁止状态)", ErrValidation)
	}
	_, err := db.Exec(`UPDATE apps SET official = ?, owner = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ?`, boolToInt(official), owner, kind, appID)
	return err
}

// SetAppOfficialOn 是 SetAppOfficial 的 executor 版本(可在 *sql.Tx 上执行)。
//
// F-15(能力中心审计 2026-10-26,P2):归属转移(transferOwner)与发布内核
// (appstore.Publish)是一对 check-then-act 竞争者 —— Publish 在**持发布锁的事务
// 内**读 owner 决定「谁能续传」,而 transferOwner 修前是一条**锁外**的单语句
// UPDATE。两者交错时,旧归属人可以在转移提交前那一刻通过 owner 检查、在提交后
// 落库,于是「新归属人已被指定,但旧归属人替新归属人发了一版」。
//
// 修法:transferOwner 在同一个事务里先取**与 Publish 相同的**发布咨询锁
// (appstore.publishLockKey)、锁内重读 apps 行、再调用本函数写,最后提交。
// 锁与写同事务 ⇒ 提交即释放,连接需求恒为 1(与 beginPublishTx 同一条纪律)。
func SetAppOfficialOn(ex Queryer, kind, appID string, official bool, owner string) error {
	if official && owner != "" {
		return fmt.Errorf("%w: 官方归属必须 owner 为空(official=1 ∧ owner 非空 是禁止状态)", ErrValidation)
	}
	_, err := ex.Exec(`UPDATE apps SET official = ?, owner = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ?`, boolToInt(official), owner, kind, appID)
	return err
}

// AppOfficialMap 返回某 kind 全部 App 的官方属性(名→bool),聚合面/列表用。
func AppOfficialMap(db *sql.DB, kind string) (map[string]bool, error) {
	rows, err := db.Query(`SELECT app_id, official FROM apps WHERE kind = ?`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		var off int
		if err := rows.Scan(&id, &off); err != nil {
			return nil, err
		}
		out[id] = off == 1
	}
	return out, rows.Err()
}

// boolToInt 布尔转 smallint。
func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// EnabledAppIDs 返回某 kind 下全部**上架**(enabled=1)的 app_id 集合。
// 读取侧一次取回后按名过滤,替代逐行查 apps 的 N+1(与 AppOfficialMap 同形):
// 清单里漏掉一个下架行,与漏掉一个不存在的行同语义。
//
// **新代码不要再用它做可见性或写入判定**(第五轮审计 R5-B-1,2026-09-23 收敛):
// 那类判定必须经 distribution.go 的 Distribution(Delivered / Writable /
// AuthorVisible)—— 否则又会退化成"每个面各写一遍 enabled 判断",而这正是
// 「作者面被下架过滤掉」「审批准了却没人看得见」的根因。本函数保留给"只要一个
// 上架集合"的批量**投影**场景(以及跨泳道尚未迁移的调用点)。
func EnabledAppIDs(db *sql.DB, kind string) (map[string]bool, error) {
	rows, err := db.Query(`SELECT app_id FROM apps WHERE kind = ? AND enabled = 1`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// AppEnabled 报告一个 App 是否上架(enabled=1),单个查询(下载/详情入口用)。
// App 不存在返回 false:nil 错误 + false 与「不存在」同语义,调用方无需区分
// (不泄露资源存在性)。
func AppEnabled(db *sql.DB, kind, appID string) (bool, error) {
	var enabled int
	err := db.QueryRow(`SELECT enabled FROM apps WHERE kind = ? AND app_id = ?`, kind, appID).Scan(&enabled)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return enabled == 1, nil
}

// SetAppTitle 只更新展示名(App 的展示元数据回写路径);owner、官方属性、
// 渠道与上下架一律不受触碰——包内 author 是不可信输入,归属只认登录态
// (P2-6,审计 2026-09-13:官方 App 的 owner 曾被包内 author 回写成个人)。
func SetAppTitle(db *sql.DB, kind, appID, title string) error {
	res, err := db.Exec(`UPDATE apps SET title = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ?`, title, kind, appID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetAppEnabled 上下架(保留数据)。
func SetAppEnabled(db *sql.DB, kind, appID string, enabled bool) error {
	res, err := db.Exec(`UPDATE apps SET enabled = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ?`, boolInt(enabled), kind, appID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// CreateRelease 写入一个新的版本快照。调用方必须已完成严格校验与版本语义
// 判定(版本不可复用、必须递增、内容未变更等),本函数只负责落库。
// (kind, app_id, version) 唯一约束兜底并发判重:竞争窗口内先落库者赢,
// 后者返回 ErrDuplicate(B7,2026-09-01——此前直接吞成 INTERNAL 500)。
func CreateRelease(db *sql.DB, r *Release) (int64, error) {
	return createRelease(db, r)
}

// createRelease 是 CreateRelease 的 executor 版本(可传入 *sql.Tx)。
func createRelease(ex queryer, r *Release) (int64, error) {
	tags := "[]"
	if len(r.Tags) > 0 {
		if b, err := json.Marshal(r.Tags); err == nil {
			tags = string(b)
		}
	}
	if r.Status == "" {
		r.Status = ReleaseStatusPending
	}
	var id int64
	err := ex.QueryRow(`INSERT INTO app_releases
		(kind, app_id, version, title, description, changelog, category, tags, author, publisher,
		 checksum, size, archive, status, reason, quality)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		r.Kind, r.AppID, r.Version, r.Title, r.Description, r.Changelog, r.Category, tags,
		r.Author, r.Publisher, r.Checksum, int64(len(r.Archive)), r.Archive, r.Status, r.Reason, r.Quality).Scan(&id)
	if err != nil && isUniqueViolation(err) {
		return 0, ErrDuplicate
	}
	return id, err
}

// GetRelease 取一个版本(含归档);软删的版本同样返回,调用方据 DeletedAt 判断。
func GetRelease(db *sql.DB, kind, appID, version string) (*Release, error) {
	r, err := scanRelease(db.QueryRow(`SELECT `+releaseFullColumns+` FROM app_releases
		WHERE kind = ? AND app_id = ? AND version = ?`, kind, appID, version), true)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// ListReleases 列出一个 App 的全部版本(不含归档),含被拒与软删——
// 版本号一经使用即永久占位(决策 D3),判重必须看到全部历史。
func ListReleases(db *sql.DB, kind, appID string) ([]Release, error) {
	return ListReleasesOn(db, kind, appID)
}

// ListReleasesByStatus 列出全部 App 的版本(管理端审核队列),status 为空 = 全部。
func ListReleasesByStatus(db *sql.DB, kind, status string) ([]Release, error) {
	q := `SELECT ` + releaseListColumns + ` FROM app_releases WHERE deleted_at IS NULL`
	args := []any{}
	if kind != "" {
		q += ` AND kind = ?`
		args = append(args, kind)
	}
	if status != "" {
		q += ` AND status = ?`
		args = append(args, status)
	}
	q += ` ORDER BY created_at DESC`
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectReleases(rows)
}

func collectReleases(rows *sql.Rows) ([]Release, error) {
	out := []Release{}
	for rows.Next() {
		r, err := scanRelease(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// ErrReleaseArchiveCleared 表示「该版本已被拒绝、归档字节已释放」,因此不能
// 再被置为 approved(N-4:审核通过意味着版本对员工可见可安装,必须有归档字节)。
// 定义在 apps.go 而不是 errors.go,因为它是本文件审核不变量的一部分。
var ErrReleaseArchiveCleared = errors.New("release archive cleared")

// ErrReleaseApprovedNotRejectable 表示目标版本**已通过审核**,因此不允许走
// 「审核拒绝」这条路径(审计 2026-09-23 ID-01)。
//
// 为什么必须是错误而不是"照旧执行":拒绝与释放归档在**同一条 UPDATE** 里完成
// (见 SetReleaseStatusForReview 的 rejected 分支),而 approved 版本可能正在对
// 全员服务(甚至是唯一可回滚的历史版本)。对它执行拒绝会
//
//	① 不可恢复地销毁归档字节(PG BYTEA 置 NULL,没有任何软删回收);
//	② 让正在服务的版本立刻对全员下载 404;
//	③ 烧掉版本号 —— (kind,app_id,version) 唯一约束 + "版本号永久占位"语义
//	   使同一版本号无法重传,再 approve 也只会得到 ErrReleaseArchiveCleared。
//
// 管理员想要的"停服务"是**另一个可逆动作**:下架(apps.enabled=0)。因此
// 「已 approved 的版本不可被拒绝」这条前置条件是产品语义,不是调用方的礼貌。
//
// **这是全仓唯一的判定实现**:三个审核面(sharedskills / agentshare /
// wasmapp)都依赖本函数返回的 sentinel,而不是各自读一遍状态位 —— 此前
// WASM 面自带一份 check-then-act 守卫、技能/智能体两面一份都没有,导致同一
// 个概念三份实现、只有一份正确。
//
// 定义在 apps.go 而不是 errors.go,与 ErrReleaseArchiveCleared 同理。
var ErrReleaseApprovedNotRejectable = errors.New("release already approved and cannot be rejected")

// 审核拒绝被拒时的**对外**文案(409)。三个审核面共用同一份,避免"同一个事实
// 三种说法"——文案是契约的一部分:它必须同时说清「发生了什么」与「该用什么
// 替代动作」,否则管理员只会反复重试。
const (
	// CodeReleaseNotRejectable 是 409 信封的 error.code。
	CodeReleaseNotRejectable = "APPROVED_NOT_REJECTABLE"
	// MsgReleaseNotRejectable 说明拒绝的破坏性后果(不可恢复)。
	MsgReleaseNotRejectable = "该版本已通过审核,不能审核拒绝:" +
		"拒绝会在同一条语句里永久释放该版本的归档字节(不可恢复),该版本将立刻无法安装或下载"
	// HintReleaseNotRejectable 指向可逆的替代动作。
	HintReleaseNotRejectable = "审核拒绝只针对待审版本;要停止服务请用「下架」(可恢复),要换内容请让作者发布新版本(版本号永久占位,不能复用)"
)

// ErrReleaseApprovedNotDeletable 表示目标版本**已通过审核**,因此不允许走
// 「版本删除」这条路径(F-01,能力中心 P0)。
//
// 与 ErrReleaseApprovedNotRejectable 同一条产品语义,但破坏面更直接:删除
// (= 软删 + `archive = NULL`)**不可恢复地**销毁正在对全员服务的归档字节,
// 并让该版本立刻从分发面消失;而 `apps` 投影行仍是旧标题 —— 目录与内容
// 分叉且没有任何自愈路径。管理员想要的"停止提供"是**另一个可逆动作**:
// 下架(apps.enabled=0)。
//
// **这是全仓唯一的判定实现**:sharedskills / agentshare 的版本删除 handler
// 都依赖本 sentinel,不再各自读一遍状态位。
var ErrReleaseApprovedNotDeletable = errors.New("release already approved and cannot be deleted")

// 版本删除被拒时的**对外**文案(409)。两面共用同一份,避免同一个事实两种说法。
const (
	// CodeReleaseNotDeletable 是 409 信封的 error.code。
	CodeReleaseNotDeletable = "RELEASE_APPROVED_NOT_DELETABLE"
	// MsgReleaseNotDeletable 说明删除的破坏性后果(不可恢复)。
	MsgReleaseNotDeletable = "该版本已通过审核,不能删除:" +
		"删除会永久清空该版本的归档字节(不可恢复),正在使用的员工将无法下载或安装"
	// HintReleaseNotDeletable 指向可逆的替代动作。
	HintReleaseNotDeletable = "只有待审/被拒版本可以删除;要停止提供请用「下架」(可恢复),要换内容请发布新版本(版本号永久占位,不能复用)"
)

// ReleaseDeletable 是「该版本能否被删除」的**唯一 Go 判定**。
//
// SQL 侧的同一判定是 DeleteReleaseUnlessApproved 的 `AND status <> 'approved'`
// —— 那一份才是并发下的真正防线;本函数只供需要在调用前给出友好提示的调用方
// 使用,两边必须同时成立(与 ReleaseRejectable 的纪律同形)。
func ReleaseDeletable(status string) bool { return status != ReleaseStatusApproved }

// ReleaseRejectable 是「该版本能否被审核拒绝」的**唯一 Go 判定**。
//
// SQL 侧的同一判定是 SetReleaseStatusForReview 的 `AND status <> 'approved'`
// —— 那一份才是并发下的真正防线(原子,不受 check-then-act 窗口影响);本函数
// 只供需要在调用前给出友好提示的调用方使用,两边必须同时成立。
func ReleaseRejectable(status string) bool { return status != ReleaseStatusApproved }

// SetReleaseStatus 审核:approved/rejected(rejected 必须带理由,由调用方保证)。
// 只改状态位,绝不触碰内容或归档——这是「快照」与「审核」得以共存的关键。
//
// 注意:这是**通用原语**,不含 F2-N3/N-4 的审核不变量(见
// SetReleaseStatusForReview)。产品的审核路径(agentshare / sharedskills 的
// admin approve|reject)必须走 ForReview 变体,因为「通过审核」意味着版本对
// 员工可见可安装,必须有归档字节 —— 这一点只能在**写入时**原子判定,不能由
// 调用方先读后写(check-then-act 会被并发绕过)。
func SetReleaseStatus(db *sql.DB, kind, appID, version, status, reason string) error {
	res, err := db.Exec(`UPDATE app_releases SET status = ?, reason = ?,
		quality = CASE WHEN ? = 'approved' THEN quality ELSE '' END, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND version = ?`,
		status, reason, status, kind, appID, version)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetReleaseStatusForReview 是**审核路径专用**的状态写入(F2-N3 + N-4):
//
//   - approved:条件 UPDATE(`archive IS NOT NULL AND deleted_at IS NULL
//     AND 应用未退役`),与「归档非空」在同一语句里判定。条件不满足时区分
//     「行不存在」(ErrNotFound)与「归档已被释放」(ErrReleaseArchiveCleared),
//     调用方据此回 404 / 409。
//     `status <> 'rejected'` 的例外:从未被拒过的行(历史/播种数据)archive
//     列为 NULL 时仍允许通过审核 —— 「归档被释放」这件事**只**发生在下面的
//     rejected 转换里,所以 `status='rejected' AND archive IS NULL` 与「被
//     释放过」等价;这条例外让迁移前的存量行不受影响(它们仍走串行审核)。
//
//     **应用未退役**(R16A-17 的收口点,2026-09-25 修正为谓词侧):退役
//     (`SoftDeleteWasmApp`)会清空该应用名下**全部**版本的 archive —— 包括
//     `status='pending'` 的待审版本 —— 而上面的例外对 pending 行恒真 ⇒ 没有
//     这条条件时,"退役 + 审核通过"的交错会产出 `approved + archive IS NULL`
//     的坏行(应用已退役,今天潜伏;一旦有"恢复应用"或任何以 status='approved'
//     为判据的读面,它立刻变成"当前生效版本没有字节")。
//     为什么放在这里而不是"退役时给 release 行置 deleted_at":那种写法会把
//     退役变成**版本级删除**,退役后保留期内作者/管理员就读不到版本清单了
//     (`TestMyReleasesSurvivesRetirement` 钉住的产品语义,见 SoftDeleteWasmApp
//     的注释)。跨表 EXISTS 在这里是安全的:两个并发写者最终都要拿 release 行的
//     行锁,后到的那条在 EPQ 里用新快照重新求值整条 WHERE(含子查询)⇒ 谁先提交
//     谁说了算,交错产不出坏行。
//
//   - rejected:拒绝与释放归档在**同一条 UPDATE**里完成(agentshare-5 的
//     存储上界:拒绝即释放,否则员工可无限循环「上传 → 被拒」堆字节)。
//     调用方不需要、也不应该再补一次清归档 —— 「置 rejected」与「清 archive」
//     分成两条语句时,中间那段窗口恰好就是被并发 approve 穿过的窗口。
//     但这条语句**只对未生效的版本成立**:`status <> 'approved'` 是前置条件
//     (审计 2026-09-23 ID-01)。approved 版本可能正在服务、也可能是唯一可
//     回滚的历史版本,拒绝它会不可恢复地销毁归档字节并烧掉版本号 ⇒ 该条件
//     不满足时返回 ErrReleaseApprovedNotRejectable(调用方映射 409),管理员
//     要停服务请用下架(apps.enabled,可逆)。历史行为(approve 后仍可 reject)
//     只对"尚未生效的待审版本"有意义,对 approved 版本是 P0 数据销毁。
//
// 为什么这就是 N-4 的修复:两个管理员并发 approve/reject 时,PostgreSQL 在
// READ COMMITTED 下用行级锁串行化两条 UPDATE,后到的那条会**重新求值**
// WHERE(EPQ),因此它看到的一定是先提交者的结果 —— 要么 approve 先提交而
// reject 的条件(status <> 'approved')不再成立而被拒,要么 reject 先提交而
// approve 的条件不再成立而拒绝。任何交错都产不出 `approved + archive IS NULL`
// 的坏行,也产不出"已生效版本的字节被销毁"。这条不变量只能写在 WHERE 里:
// 调用方先读后写(check-then-act)在并发下必被绕过。
func SetReleaseStatusForReview(db *sql.DB, kind, appID, version, status, reason string) error {
	return setReleaseStatusForReview(db, kind, appID, version, status, reason, false)
}

// SetReleaseStatusForReviewIfWritable 是技能/智能体审核路径用的变体:approve 时
// 在**同一条 UPDATE** 里额外要求 `apps.enabled = 1`(F-14,能力中心审计
// 2026-10-26,P1)。
//
// 修前:所有审核路径都是「先读 Distribution.Writable() 判下架 → 再调
// SetReleaseStatusForReview」的 check-then-act。两次读之间管理员按下「下架」时,
// approve 仍然通过 ⇒ 产出「已批准但任何人(含作者)都看不见」的版本 —— 正是
// 下架冻结要消除的形态(R5-B-1)。并发下唯一可靠的落点是 UPDATE 的 WHERE:
// 下架 UPDATE 与 approve UPDATE 会争同一条 apps 行的行锁,后到者在 EPQ 里
// 重新求值含 `a.enabled = 1` 的子查询,于是要么先下架(approve 0 行 ⇒
// ErrAppDelisted),要么先批准(下架随后生效,内容可见性由 enabled 决定)。
//
// 为什么不做成 SetReleaseStatusForReview 的默认行为:WASM 应用共用这张表但
// 走自己的部署/撤回生命周期(它的「不可分发」是 unpublish/withdraw 而不是
// `apps.enabled` 冻结),对它加 enabled 谓词会改变既有语义;技能/智能体两面
// 显式选这个变体,差异只在这里可见。
func SetReleaseStatusForReviewIfWritable(db *sql.DB, kind, appID, version, status, reason string) error {
	return setReleaseStatusForReview(db, kind, appID, version, status, reason, true)
}

func setReleaseStatusForReview(db *sql.DB, kind, appID, version, status, reason string, requireWritable bool) error {
	switch status {
	case ReleaseStatusApproved:
		// F-14:下架冻结的原子前置条件(只有技能/智能体审核路径要求)。
		writableClause := ""
		if requireWritable {
			writableClause = "\n\t\t\t    AND a.enabled = 1"
		}
		res, err := db.Exec(`UPDATE app_releases SET status = ?, reason = '',
			updated_at = `+NowExpr()+`
			WHERE kind = ? AND app_id = ? AND version = ? AND deleted_at IS NULL
			  AND (archive IS NOT NULL OR status <> 'rejected')
			  AND EXISTS (SELECT 1 FROM apps a
			              WHERE a.kind = app_releases.kind AND a.app_id = app_releases.app_id
			                AND a.deleted_at IS NULL`+writableClause+`)`,
			status, kind, appID, version)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			var exists bool
			if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM app_releases
				WHERE kind = ? AND app_id = ? AND version = ?)`, kind, appID, version).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return ErrNotFound
			}
			if requireWritable {
				// 0 行时先看是不是「下架冻结」挡下的:它比「归档已释放」更可操作
				// (重新上架即可重试),也是 F-14 修复要暴露的那条语义。
				var enabled int
				serr := db.QueryRow(`SELECT enabled FROM apps WHERE kind = ? AND app_id = ?`,
					kind, appID).Scan(&enabled)
				if serr == nil && enabled == 0 {
					return ErrAppDelisted
				}
				if serr != nil && !errors.Is(serr, sql.ErrNoRows) {
					return serr
				}
			}
			return ErrReleaseArchiveCleared
		}
		return nil
	case ReleaseStatusRejected:
		res, err := db.Exec(`UPDATE app_releases SET status = ?, reason = ?, quality = '',
			archive = NULL, size = 0, updated_at = `+NowExpr()+`
			WHERE kind = ? AND app_id = ? AND version = ? AND status <> ?`,
			status, reason, kind, appID, version, ReleaseStatusApproved)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			// 0 行只有两种可能:行不存在,或行**已通过审核**(被上面的
			// `status <> ?` 挡下)。两者对调用方的语义完全不同(404 vs 409),
			// 必须区分 —— 这里的第二个查询只用于在**已经判定拒绝失败**之后
			// 解释原因,不构成 check-then-act:真正的前置条件已经由 UPDATE
			// 的分支保证,并发的 approve 只会让这次拒绝更早返回 sentinel。
			var exists bool
			if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM app_releases
				WHERE kind = ? AND app_id = ? AND version = ?)`, kind, appID, version).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return ErrNotFound
			}
			return ErrReleaseApprovedNotRejectable
		}
		return nil
	default:
		return SetReleaseStatus(db, kind, appID, version, status, reason)
	}
}

// 质量标记的合法取值（F-39 / F-47，能力中心审计 2026-10-26）。
//
// 语义权威：” = 无标记；official = 官方；featured = 精选（0037 引入，二者互斥）。
// 迁移 0090 给 `app_releases.quality` 补了同一条 CHECK（NOT VALID：存量不回溯，
// 新写入立即受约束）；Go 侧的唯一写入口是 SetReleaseQuality，两边必须同时成立
// —— SQL 是并发下的最后防线，Go 侧负责给出可读的 ErrValidation 而不是让调用方
// 收到一个数据库约束错误。
const (
	// QualityNone 无质量标记。
	QualityNone = ""
	// QualityOfficial 官方标记。
	QualityOfficial = "official"
	// QualityFeatured 精选标记。
	QualityFeatured = "featured"
)

// MaxPendingPerAuthor 是**每个作者**待审版本数上限（审核队列防洪）。
//
// F-47（能力中心审计 2026-10-26，P3）：这个数字修前在 sharedskills 与 agentshare
// 各写一份 `const pendingCap = 10`。两处一旦不同，同一个员工在「技能」与「智能体」
// 两个面就会看到不同的待审上限，而运营文档写的是同一个数。现在唯一真源在这里，
// 两个上传入口都引用它。
const MaxPendingPerAuthor = 10

// ValidReleaseQuality 是质量标记取值域的**唯一 Go 判定**（与迁移 0090 的 CHECK 同域）。
func ValidReleaseQuality(q string) bool {
	switch q {
	case QualityNone, QualityOfficial, QualityFeatured:
		return true
	}
	return false
}

// SetReleaseQuality 质量标记(”|official|featured),仅 approved 版本可设置。
//
// F-39：修前这里**不校验** quality，任何字符串都能落库（投影回填/数据修复脚本
// 也走这个入口），而管理端徽章判定是 `== featured` / `== official` —— 脏值会
// 静默不出徽章。现在取值域在 Go 侧（本函数）与 SQL 侧（0090 的 CHECK）各判一次。
func SetReleaseQuality(db *sql.DB, kind, appID, version, quality string) error {
	if !ValidReleaseQuality(quality) {
		return ErrValidation
	}
	res, err := db.Exec(`UPDATE app_releases SET quality = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND version = ? AND status = 'approved'`,
		quality, kind, appID, version)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SoftDeleteRelease 软删一个版本:内容不再可用,但版本号永久占位不可复用。
//
// 这是**通用原语**(播种/数据修复用),不包含产品不变量:它同样会删掉
// approved 版本并清空归档。产品的「删除版本」入口必须走
// DeleteReleaseUnlessApproved(F-01:P0 已通过版本删除 = 不可恢复的数据销毁)。
func SoftDeleteRelease(db *sql.DB, kind, appID, version string) error {
	res, err := db.Exec(`UPDATE app_releases SET deleted_at = `+NowExpr()+`, archive = NULL,
		updated_at = `+NowExpr()+` WHERE kind = ? AND app_id = ? AND version = ? AND deleted_at IS NULL`,
		kind, appID, version)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteReleaseUnlessApproved 软删一个**尚未生效**的版本(pending/rejected)。
//
// 产品不变量(能力中心 F-01,2026-10-26):已通过审核的版本不可删除 ——
// 它可能正在对全员服务,也可能是唯一可回滚的历史版本;删除与释放归档在同一
// 条 UPDATE 里完成(PG BYTEA 置 NULL,没有回收站),对 approved 版本执行它
// 等于不可恢复地销毁内容,还让 apps 投影停在一个已经没有内容的标题上。
//
// 判定写在 UPDATE 的 WHERE 里(`status <> 'approved'`),并发下的真正防线
// 是这条原子语句,不是调用方的 check-then-act;0 行时再解释原因(与
// SetReleaseStatusForReview 的 rejected 分支同一纪律)。
func DeleteReleaseUnlessApproved(db *sql.DB, kind, appID, version string) error {
	res, err := db.Exec(`UPDATE app_releases
		SET deleted_at = `+NowExpr()+`, archive = NULL, size = 0, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND version = ? AND deleted_at IS NULL AND status <> ?`,
		kind, appID, version, ReleaseStatusApproved)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return nil
	}
	// 0 行:行不存在/已被并发删除(404),或行已 approved(409)。
	// 这条解释性查询不构成 check-then-act —— 前置条件已由上面的 WHERE 保证。
	var status string
	err = db.QueryRow(`SELECT status FROM app_releases
		WHERE kind = ? AND app_id = ? AND version = ? AND deleted_at IS NULL`,
		kind, appID, version).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if status == ReleaseStatusApproved {
		return ErrReleaseApprovedNotDeletable
	}
	// 状态位既非 approved 却仍 0 行:并发删除已经把它软删了,与不存在同义。
	return ErrNotFound
}

// IncrementReleaseDownload 下载计数(best effort)。
func IncrementReleaseDownload(db *sql.DB, kind, appID, version string) error {
	_, err := db.Exec(`UPDATE app_releases SET downloads = downloads + 1
		WHERE kind = ? AND app_id = ? AND version = ?`, kind, appID, version)
	return err
}

// ---------------------------------------------------------------------------
// 授权(App 级:同名多版本共享一份授权,与旧语义一致)
// ---------------------------------------------------------------------------

// GrantApp 授权给用户或部门组(幂等)。
func GrantApp(db *sql.DB, kind, appID, grantee, granteeType string) error {
	_, err := db.Exec(`INSERT INTO app_grants (kind, app_id, grantee_type, grantee)
		VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`, kind, appID, granteeType, grantee)
	return err
}

// RevokeApp 撤销一条授权。
func RevokeApp(db *sql.DB, kind, appID, grantee, granteeType string) error {
	_, err := db.Exec(`DELETE FROM app_grants
		WHERE kind = ? AND app_id = ? AND grantee_type = ? AND grantee = ?`,
		kind, appID, granteeType, grantee)
	return err
}

// ListAppGrants 列出一个 App 的授权对象。
func ListAppGrants(db *sql.DB, kind, appID string) ([]Grant, error) {
	rows, err := db.Query(`SELECT grantee_type, grantee FROM app_grants
		WHERE kind = ? AND app_id = ? ORDER BY grantee_type, grantee`, kind, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Grant{}
	for rows.Next() {
		var g Grant
		if err := rows.Scan(&g.GranteeType, &g.Grantee); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// AccessibleAppIDs 返回某用户(含其部门组)有权访问的 App 名单。
// 严格默认:未授权即不可见(与旧三域一致)。
func AccessibleAppIDs(db *sql.DB, kind, username string, groups []string) ([]string, error) {
	q := `SELECT DISTINCT app_id FROM app_grants WHERE kind = ? AND (
			(grantee_type = 'user' AND lower(grantee) = lower(?))`
	args := []any{kind, username}
	if len(groups) > 0 {
		q += ` OR (grantee_type = 'group' AND lower(grantee) IN (` + qmarks(len(groups)) + `))`
		for _, g := range groups {
			args = append(args, strings.ToLower(g))
		}
	}
	q += `)`
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}
