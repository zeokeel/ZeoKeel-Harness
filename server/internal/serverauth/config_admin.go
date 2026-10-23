package serverauth

// 部署期配置注册表的管理端出口（「系统配置」页）：GET/PUT /api/server/admin/config。
//
// 背景（2026-10-23，用户要求「系统配置配到数据库里，不要用一大堆环境变量启动」）：
// 过去 wasm 内存档位/编译隔离档、OIDC 信任主机、登录失败上限、遥测/审计间隔这类
// **部署期旋钮**只能改 .env + 重建容器，控制台既看不到"有哪些键/现在是多少/
// 默认是多少"，也没法在不重建容器的前提下调整。`internal/deployconfig` 已把这
// 批键收成一张**唯一真源注册表**（键名、历史环境变量名、类型、默认值、取值域、
// 生效时机、解析优先级）；本文件只做"把它暴露成管理端 API"这一件事，不重复实现
// 任何解析/校验口径：
//
//   - 读：逐个键给出生效值 + 来源（env|setting|default）+ 两侧原始值 + 非法说明；
//   - 写：只接受注册表认识的键，值一律过 `Key.Parse`（与读取路径**同一份**校验），
//     空串 = 删除该 settings 行（回落 env/默认）。
//
// 为什么写库必须与审计同事务（而不是"先写库、再 AuditLog"）：这些键里有**启动闸门**
// （wasm.memory_profile 选错会让小内存机器起不来）与**安全预算**（登录失败上限、
// 允许明文 LDAP）。业务写成功而审计写失败，就会留下"配置被改了、没有任何痕迹"的
// 路径；反过来审计先落而业务回滚则会出现"审计说改了、其实没改"。范式与本仓
// `internal/llmgateway/admin.go` 的 auditSetSettingTx 一致：Begin + defer Rollback +
// GetSettingTx（同事务内读旧值）+ SetSettingTx/AuditLogTx + Commit。
//
// 为什么响应里要带 warnings：环境变量的优先级**高于** settings（升级安全 + 逃生口，
// 见 deployconfig 包注释）。运维在控制台"保存成功"但 .env 里还写着同一个键时，
// 值不会生效 —— 不点名就是一条无迹可查的"改了没反应"。所以 PUT 对**仍被环境变量
// 覆盖**的键逐个给出可操作的 warning（"请删除 .env 对应行"）。
//
// 错误一律走 serverauth.WriteError 信封（code/message），成功 c.JSON。

import (
	"database/sql"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/deployconfig"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// ConfigItem 是 GET /api/server/admin/config 的一个配置项（字段名是与前端的稳定契约）。
//
// `value`/`source` 是"现在真正生效的是什么、从哪里来"；`default`/`env_value`/
// `setting_value` 是排障需要的三份原始输入 —— 只看 value/source 无法回答
// "环境变量是不是设了个非法值被回落了"（那正是 `invalid` 的用途）。
type ConfigItem struct {
	// Key 是 settings 表的键（唯一真源 = deployconfig 注册表）。
	Key string `json:"key"`
	// Env 是历史上覆盖该键的环境变量名（存量部署靠它平滑升级）。
	Env string `json:"env"`
	// Title/Description/Category 是控制台展示用的中文名、一句话说明与分组。
	Title       string `json:"title"`
	Description string `json:"description"`
	Category    string `json:"category"`
	// Kind 决定前端控件（string/int/bool/duration/csv/choice）。
	Kind string `json:"kind"`
	// Value 是**生效值**（已按 Kind 规范化）；Source 是它的来源。
	Value  string `json:"value"`
	Source string `json:"source"`
	// Default 是内置默认值（原始形态，与 value 同口径规范化）。
	Default string `json:"default"`
	// AppliesAt：hot = 保存即生效；restart = 需重启/重建容器。
	AppliesAt string `json:"applies_at"`
	// Min/Max 是整型取值域（nil = 该方向不限制）。
	Min *int64 `json:"min"`
	Max *int64 `json:"max"`
	// Choices 是 choice 类的候选（按注册表顺序；非 choice 为空数组）。
	Choices []string `json:"choices"`
	// EnvValue/SettingValue 是两侧原始值（未设置时为空串）。
	EnvValue     string `json:"env_value"`
	SettingValue string `json:"setting_value"`
	// Invalid 非空表示某个来源的取值非法、已被回落（内容可直接展示给运维）。
	Invalid string `json:"invalid"`
}

// configPutRequest 是 PUT /api/server/admin/config 的请求体。
//
// values 的值类型刻意是 string：注册表里所有键的**规范形态**都是字符串，校验
// （bool/int/duration/choice/CSV 的合法化）只在 Key.Parse 一处实现。让 JSON 数字
// 直通会在 Go 侧再分叉出一套"数字怎么算合法"的口径。
type configPutRequest struct {
	Values map[string]string `json:"values"`
}

// DeployConfigAdminHandlers 是「系统配置」管理端点集合。
//
// 为什么不挂在 AdminAPI.Handlers() 上：deployconfig 是**独立于业务域**的基础设施
// 注册表（它还被启动期装配与各业务的读取路径直接使用），这组端点只依赖 db，
// 不与 AdminAPI 的其他状态耦合；单独供给能让 `internal/router` 按同一入口装配，
// 也给包内测试一个不依赖完整 AdminAPI 的构造点。
type DeployConfigAdminHandlers struct {
	Get gin.HandlerFunc
	Put gin.HandlerFunc
}

// NewDeployConfigAdminHandlers 构造管理端配置 handler 集合。
//
// db == nil 时读面退化为"只看环境变量与默认值"（deployconfig.Resolve 明确支持
// nil db，供单机工具/测试使用）；写面返回 500（没有库就没有可写目标）。
func NewDeployConfigAdminHandlers(db *sql.DB) *DeployConfigAdminHandlers {
	h := &deployConfigState{db: db}
	return &DeployConfigAdminHandlers{Get: h.get, Put: h.put}
}

type deployConfigState struct {
	db *sql.DB
}

// get 返回注册表全量键的当前状态 + 被环境变量覆盖的键名清单。
//
// 返回**全部**键（而不是只返回已配置的）：这张表的用途就是"有哪些旋钮、现在多少、
// 默认多少"，漏掉任何一个都会让运维以为它不存在。规范顺序 = 注册表顺序（同时也是
// 控制台展示顺序）。
func (s *deployConfigState) get(c *gin.Context) {
	values := deployconfig.Snapshot(s.db)
	items := make([]ConfigItem, 0, len(values))
	for _, v := range values {
		k := v.Key
		choices := k.Choices
		if choices == nil {
			// 非 choice 类给空数组：前端/外部调用方不必区分 null 与 []。
			choices = []string{}
		}
		items = append(items, ConfigItem{
			Key:          k.Setting,
			Env:          k.Env,
			Title:        k.Title,
			Description:  k.Description,
			Category:     k.Category,
			Kind:         string(k.Kind),
			Value:        v.Raw,
			Source:       string(v.Source),
			Default:      k.Default,
			AppliesAt:    k.AppliesAt,
			Min:          k.Min,
			Max:          k.Max,
			Choices:      choices,
			EnvValue:     v.EnvRaw,
			SettingValue: v.SettingRaw,
			Invalid:      v.Invalid,
		})
	}
	overrides := deployconfig.EnvOverridden(s.db)
	if overrides == nil {
		overrides = []string{}
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "env_overrides": overrides})
}

// put 批量保存控制台配置：校验全部通过 → 单事务写库+审计 → 返回 saved/warnings。
//
// 三条纪律（缺任一条都会退化成"看起来保存成功"）：
//  1. **先校验全部键与值，再开事务**：未知键/非法值一律 400，且不留下半套配置
//     （旧 llmgateway 的"逐键写、写一半 400"正是被审计收口过的形态）。
//  2. **写库与审计同事务**：任一失败整体回滚（含审计），提交后失效 settings 缓存
//     （SetSettingTx 不主动失效，缺了它会"保存成功、运行期仍读旧值"）。
//  3. **空串 = 删除该 settings 行**（不是把空串存进去）：存空串会让"未配置"与
//     "显式清空"在读取路径上不可区分，回落语义（env/默认）也就无法表达。
func (s *deployConfigState) put(c *gin.Context) {
	var req configPutRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体必须是 {\"values\":{\"<键>\":\"<值>\"}}")
		return
	}
	if len(req.Values) == 0 {
		WriteError(c, http.StatusBadRequest, "VALIDATION", "values 不能为空")
		return
	}
	if s.db == nil {
		WriteError(c, http.StatusInternalServerError, "INTERNAL", "数据库不可用，无法保存配置")
		return
	}

	// 1) 全量预校验（按注册表顺序，未知键单独列出；值用 Key.Parse 与读取路径同一口径）。
	keys := deployconfig.Keys()
	known := make(map[string]deployconfig.Key, len(keys))
	for _, k := range keys {
		known[k.Setting] = k
	}
	var unknown []string
	for key := range req.Values {
		if _, ok := known[key]; !ok {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		// 排序只为让错误信息稳定（map 迭代顺序随机）。
		sort.Strings(unknown)
		WriteError(c, http.StatusBadRequest, "VALIDATION", "未知配置键："+strings.Join(unknown, ", "))
		return
	}
	// canonical 是"要落库的规范形态"（空串 = 删除该行）。
	canonical := make(map[string]string, len(req.Values))
	for key, raw := range req.Values {
		canon, err := known[key].Parse(raw)
		if err != nil {
			WriteError(c, http.StatusBadRequest, "VALIDATION", err.Error())
			return
		}
		canonical[key] = canon
	}

	// 2) 单事务：读旧值（同事务，走 GetSettingTx 避免持连接再向池要连接）→ 写/删 →
	//    审计（detail 逐键 "key: old→new"）。
	tx, err := serverstore.UsageWriteTx(s.db)
	if err != nil {
		WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	defer tx.Rollback() //nolint:errcheck // 提交后回滚是 no-op

	saved := make([]string, 0, len(canonical))
	changes := make([]string, 0, len(canonical))
	for _, k := range keys {
		canon, ok := canonical[k.Setting]
		if !ok {
			continue
		}
		old, _, err := serverstore.GetSettingTx(tx, s.db, k.Setting)
		if err != nil {
			// 旧值只用于审计明细：读不到就按"空"记，不阻断保存（写入本身仍会暴露真实错误）。
			old = ""
		}
		if canon == "" {
			// 语句收在 serverstore（DeleteSettingTx）：settings 是族内关系，包外直写
			// SQL 会成为一条未登记的 search_path 路径（R13-GH3 守卫）。
			if _, err := serverstore.DeleteSettingTx(tx, k.Setting); err != nil {
				WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
				return
			}
		} else if err := serverstore.SetSettingTx(tx, k.Setting, canon); err != nil {
			WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
		saved = append(saved, k.Setting)
		if old != canon {
			changes = append(changes, fmt.Sprintf("%s: %s→%s", k.Setting, configAuditValue(old), configAuditValue(canon)))
		}
	}
	// 无变更时不留审计噪声（审计链回答的是"谁改过什么"，没改就不用写）。
	if len(changes) > 0 {
		if err := serverstore.AuditLogTx(tx, currentAdminUsername(c), "deploy_config", strings.Join(changes, ", ")); err != nil {
			WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	// 3) 提交后必须失效 settings 缓存（见 serverstore.SetSettingTx 注释）。
	serverstore.InvalidateSettings()

	// 4) 仍被环境变量覆盖的键逐个点名：保存成功 ≠ 生效。
	warnings := make([]string, 0)
	for _, key := range saved {
		if !deployconfig.Resolve(s.db, known[key]).SetByEnv() {
			continue
		}
		k := known[key]
		warnings = append(warnings, fmt.Sprintf(
			"%s（%s）仍被环境变量覆盖，控制台修改不生效；覆盖它的环境变量是 %s —— 如需以控制台为准，请删除 .env 中的对应行（改完需重建容器）。",
			k.Title, k.Setting, k.Env))
	}
	c.JSON(http.StatusOK, gin.H{"saved": saved, "warnings": warnings})
}

// configAuditValue 把取值折叠成可进审计 detail 的形状。
//
// 空值必须看得见（否则 "old→(空)" 与 "old→" 在详情里同形，运维会误读成"没改成"）；
// 过长取值截断：审计行参与哈希链、不可改写且默认保留 180 天，一条配置值不该独占
// 一段不可变存储（取值本身仍可在「系统配置」页看到）。
func configAuditValue(raw string) string {
	if raw == "" {
		return "(空)"
	}
	const maxRunes = 120
	r := []rune(raw)
	if len(r) <= maxRunes {
		return raw
	}
	return string(r[:maxRunes]) + "…"
}
