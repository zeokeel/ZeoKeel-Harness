// Package deployconfig 是**部署期可调项的唯一真源**（2026-10-23，用户要求
// 「系统配置配到数据库里，不要用一大堆环境变量启动」）。
//
// 为什么要这一层：
//
//	过去这类旋钮散落在 8 个包各自 `os.Getenv("ZEOKEEL_X")`，于是有三个结构性后果：
//	  1. 运维要改一个限流/间隔，只能改 .env + 重建容器（容器里的 env 是启动期快照）；
//	  2. 控制台完全看不到它们（webadmin 只有各业务域自己的配置面），"能不能调、
//	     现在是多少、默认是多少"三件事都没有可视出口；
//	  3. 每个键的解析口径各自实现（空串算不算设置、非法值回落不回落、回落告警不告警）
//	     —— 同一个部署里出现两套口径，正是本仓审计里反复收口的那类缺陷。
//
// 本包把这些键收成一张**注册表**（registry）：键名、历史环境变量名、中文名、
// 说明、类型、默认值、取值域、生效时机都在一处声明；解析只在本包实现一次。
//
// 生效优先级（全键统一，且可以被运维用一句话说明清楚）：
//
//	显式环境变量（非空） > 控制台保存的设置 > 内置默认
//
// 为什么保留环境变量在最高优先级，而不是"库优先"：
//   - **升级安全**：存量部署的 .env 里就写着这些键，若改成库优先，升级后行为会
//     静默变化（例如小内存机器原本 small 被回落 default ⇒ 启动自检拒绝启动，
//     而那台机器连控制台都进不去）；
//   - **逃生口**：`wasm.memory_profile` / `wasm.compile_isolation` 是**启动闸门**，
//     库里的值配错会让容器起不来 —— 这时只有环境变量这个"容器外的开关"能救；
//   - **不静默**：环境变量压过库值时，「系统配置」页与启动日志都会点名列出被覆盖的键，
//     所以"我在控制台改了怎么没生效"不会成为一个没有线索的谜。
//
// 反过来，新部署**不需要**设置任何环境变量：不设 = 用库/默认，控制台随时可改。
package deployconfig

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Source 报告一个生效值的来源。对外（管理端 API/前端徽标）是稳定契约，
// 不要改成中文以外的写法而不改前端。
type Source string

const (
	// SourceDefault 内置默认值。
	SourceDefault Source = "default"
	// SourceSetting 控制台保存的 settings 行。
	SourceSetting Source = "setting"
	// SourceEnv 显式环境变量覆盖。
	SourceEnv Source = "env"
)

// Kind 是配置值的类型；决定解析/校验/前端控件。
type Kind string

const (
	KindString   Kind = "string"
	KindInt      Kind = "int"
	KindBool     Kind = "bool"
	KindDuration Kind = "duration"
	KindCSV      Kind = "csv"
	KindChoice   Kind = "choice"
)

// 生效时机：hot = 保存即生效（读路径每次解析）；restart = 需要重启/重建容器
// （值是启动期一次性装配的，例如调度器 tick、平台内存档位）。
const (
	AppliesHot     = "hot"
	AppliesRestart = "restart"
)

// Key 描述一个可配置项。零值不可用；全部实例必须来自下面的 registry。
type Key struct {
	// Setting 是 settings 表的键（唯一）。
	Setting string
	// Env 是历史上的环境变量名（覆盖口）。所有键都保留它：存量部署靠它平滑升级。
	Env string
	// Title 是控制台展示用的中文名。
	Title string
	// Description 是一句话说明（控制台副标题、API 返回）。
	Description string
	// Category 是控制台分组。
	Category string
	Kind     Kind
	// Default 是内置默认值（字符串形态，按 Kind 解析）。typed 键必须非空。
	Default string
	// Min/Max 是 KindInt 的取值域；nil = 该方向不限制。
	Min *int64
	Max *int64
	// MinDuration 是 KindDuration 的下限；0 = 不限制（但仍必须 > 0）。
	MinDuration time.Duration
	// Choices 是 KindChoice 的候选（按展示顺序；比较大小写不敏感）。
	Choices []string
	// AppliesAt 是生效时机（AppliesHot / AppliesRestart）。
	AppliesAt string
}

func int64p(v int64) *int64 { return &v }

// registry 是全部可配置项的**规范顺序**（= 控制台展示顺序、API 返回顺序）。
//
// 新增键的纪律：
//  1. 先在这里声明（含说明与取值域），再改调用点 —— 不要反过来；
//  2. Env 名以 ZEOKEEL_ 开头且必须与历史代码里用过的名字**逐字一致**（改名 = 换契约）；
//  3. 启动闸门类（配错会让容器起不来）必须写 AppliesRestart，并在 Description 里
//     点明"配错会拒绝启动"；
//  4. 判据：keys_test.go 断言 Setting/Env 唯一、默认值可解析、取值域自洽。
var registry = []Key{
	{
		Setting:     "deploy.update_endpoint",
		Env:         "ZEOKEEL_UPDATE_ENDPOINT",
		Title:       "更新清单地址",
		Category:    "对外地址与更新",
		Kind:        KindString,
		Default:     "",
		AppliesAt:   AppliesHot,
		Description: "服务端检查新版本用的清单地址。留空 = 按本部署渠道取默认目录（release.zeokeel.com/<渠道>/latest.json）；填 off / none / disabled 关闭更新检查（留空不等于关闭）。",
	},
	{
		Setting:     "deploy.trusted_hosts",
		Env:         "ZEOKEEL_TRUSTED_HOSTS",
		Title:       "OIDC 回跳信任主机",
		Category:    "网络与反代",
		Kind:        KindCSV,
		Default:     "",
		AppliesAt:   AppliesHot,
		Description: "OIDC 登录回跳时额外信任的对外主机名（逗号分隔）。反代/多域名部署时补；留空 = 只按请求推导。",
	},
	{
		Setting:     "auth.login_max_attempts",
		Env:         "ZEOKEEL_LOGIN_MAX_ATTEMPTS",
		Title:       "登录失败上限",
		Category:    "认证与安全",
		Kind:        KindInt,
		Default:     "10",
		Min:         int64p(1),
		Max:         int64p(1_000_000),
		AppliesAt:   AppliesHot,
		Description: "单账号在窗口内的登录失败上限，超限锁定。仅测试环境建议调大（默认 10）。",
	},
	{
		Setting:     "auth.ldap_allow_plaintext",
		Env:         "ZEOKEEL_LDAP_ALLOW_PLAINTEXT",
		Title:       "允许明文 LDAP",
		Category:    "认证与安全",
		Kind:        KindBool,
		Default:     "false",
		AppliesAt:   AppliesHot,
		Description: "放行非回环 ldap://（bind 密码明文过网）。仅当目录服务不支持 LDAPS 时才开启，开启后保存配置会在日志里大声告警。",
	},
	{
		Setting:     "gateway.max_inflight_per_user",
		Env:         "ZEOKEEL_GATEWAY_MAX_INFLIGHT_PER_USER",
		Title:       "单用户并发请求上限",
		Category:    "AI 网关",
		Kind:        KindInt,
		Default:     "32",
		Min:         int64p(1),
		Max:         int64p(1_000_000),
		AppliesAt:   AppliesHot,
		Description: "每个员工同时在跑的 AI 网关请求数上限（超限 429）。它不是速率限制；速率由「网关」页的每用户限流配置。",
	},
	{
		Setting:     "telemetry.max_per_min",
		Env:         "ZEOKEEL_TELEMETRY_MAX_PER_MIN",
		Title:       "遥测上报上限（每用户/分钟）",
		Category:    "遥测",
		Kind:        KindInt,
		Default:     "60",
		Min:         int64p(0),
		Max:         int64p(1_000_000),
		AppliesAt:   AppliesHot,
		Description: "客户端技能调用上报的每用户每分钟上限；0 = 不限（仅测试/压测）。",
	},
	{
		Setting:     "telemetry.max_per_skill_per_min",
		Env:         "ZEOKEEL_TELEMETRY_MAX_PER_SKILL_PER_MIN",
		Title:       "遥测上报上限（每技能/分钟）",
		Category:    "遥测",
		Kind:        KindInt,
		Default:     "10",
		Min:         int64p(0),
		Max:         int64p(1_000_000),
		AppliesAt:   AppliesHot,
		Description: "单个技能每分钟的调用上报上限（防刷榜）；0 = 不限。",
	},
	{
		Setting:     "telemetry.error_reporting_max_per_min",
		Env:         "ZEOKEEL_TELEMETRY_ERROR_REPORTING_MAX_PER_MIN",
		Title:       "错误上报上限（每用户/分钟）",
		Category:    "遥测",
		Kind:        KindInt,
		Default:     "10",
		Min:         int64p(0),
		Max:         int64p(1_000_000),
		AppliesAt:   AppliesHot,
		Description: "客户端错误上报的每用户每分钟上限；0 = 不限。",
	},
	{
		Setting:  "audit.chain_interval",
		Env:      "ZEOKEEL_AUDIT_CHAIN_INTERVAL",
		Title:    "审计链校验间隔",
		Category: "审计",
		Kind:     KindDuration,
		Default:  "1h",
		// 下限只挡"退化到无间隔"的写法：旧实现接受**任意正** duration，存量部署确
		// 有 30s 的档；若这里取 1m，升级后那台机器的 30s 会被判非法并回落 1h ——
		// 可见性窗口静默放大 120 倍（正是本仓审计反复收口的"升级即静默改行为"）。
		// 1s 既保留存量取值，又挡住 0/负数/纳秒级抖动。
		MinDuration: time.Second,
		AppliesAt:   AppliesRestart,
		Description: "审计哈希链周期校验的间隔（Go duration，如 15m / 1h）。它同时是「审计篡改的可见性窗口」与「每轮一次 audit_logs 只读扫描」的取舍。",
	},
	{
		Setting:     "wasm.apps_extra_reserved",
		Env:         "ZEOKEEL_APPS_EXTRA_RESERVED",
		Title:       "应用保留名",
		Category:    "应用平台",
		Kind:        KindCSV,
		Default:     "",
		AppliesAt:   AppliesRestart,
		Description: "WASM 应用 id 不得占用的额外保留名（逗号分隔，如 intranet,oa）；命中即拒绝发布。",
	},
	{
		Setting:     "wasm.memory_profile",
		Env:         "ZEOKEEL_WASM_MEMORY_PROFILE",
		Title:       "应用平台内存档位",
		Category:    "应用平台",
		Kind:        KindChoice,
		Default:     "default",
		Choices:     []string{"default", "small", "large"},
		AppliesAt:   AppliesRestart,
		Description: "default = 32 并发 × 64 MiB（≈2.7 GiB 峰值）；small = 3 并发（≈630 MiB）；large = 64 并发（≈4.7 GiB）。**可用内存 < 4 GiB 的机器必须选 small，否则启动自检会拒绝启动**（此时可用环境变量临时覆盖）。",
	},
	{
		Setting:     "wasm.compile_isolation",
		Env:         "ZEOKEEL_COMPILE_ISOLATION",
		Title:       "编译子进程隔离档",
		Category:    "应用平台",
		Kind:        KindChoice,
		Default:     "auto",
		Choices:     []string{"require", "auto", "off"},
		AppliesAt:   AppliesRestart,
		Description: "require = 隔离不可用即拒绝启动（生产推荐）；auto = 可用则启用、不可用则大声记日志后继续（默认）；off = 关闭（仅测试）。配错 require 会让服务端起不来。",
	},
}

// Keys 返回注册表的副本（规范顺序）。调用方不得依赖返回切片可写。
func Keys() []Key {
	out := make([]Key, len(registry))
	copy(out, registry)
	return out
}

// BySetting 按键名查找注册项（未知键返回 false，不猜）。
func BySetting(setting string) (Key, bool) {
	for _, k := range registry {
		if k.Setting == setting {
			return k, true
		}
	}
	return Key{}, false
}

// ByEnv 按环境变量名查找注册项。
func ByEnv(env string) (Key, bool) {
	for _, k := range registry {
		if k.Env == env {
			return k, true
		}
	}
	return Key{}, false
}

// SettingKeys 返回全部 settings 键（规范顺序）。
func SettingKeys() []string {
	out := make([]string, 0, len(registry))
	for _, k := range registry {
		out = append(out, k.Setting)
	}
	return out
}

// Parse 把**非空原始串**解析成本类的规范形态；非法值返回带键名的错误。
//
// 约定：空串表示"未配置"，由 Resolve 处理，不属于解析错误。所有调用方（读取路径、
// 控制台保存路径）共用这一份校验 —— 否则"控制台能存进去、启动时被判非法回落"
// 这种两侧口径漂移会再次出现。
func (k Key) Parse(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	switch k.Kind {
	case KindString:
		if strings.ContainsAny(raw, "\r\n\t") {
			return "", fmt.Errorf("%s 不能包含换行/制表符", k.Title)
		}
		return raw, nil
	case KindBool:
		switch strings.ToLower(raw) {
		case "1", "true", "yes", "on":
			return "true", nil
		case "0", "false", "no", "off":
			return "false", nil
		default:
			return "", fmt.Errorf("%s 必须是布尔值（true/false、1/0、yes/no、on/off），收到 %q", k.Title, raw)
		}
	case KindInt:
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return "", fmt.Errorf("%s 必须是整数，收到 %q", k.Title, raw)
		}
		if k.Min != nil && n < *k.Min {
			return "", fmt.Errorf("%s 不能小于 %d（收到 %d）", k.Title, *k.Min, n)
		}
		if k.Max != nil && n > *k.Max {
			return "", fmt.Errorf("%s 不能大于 %d（收到 %d）", k.Title, *k.Max, n)
		}
		return strconv.FormatInt(n, 10), nil
	case KindDuration:
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			return "", fmt.Errorf("%s 必须是正的时长（Go duration，如 15m / 1h），收到 %q", k.Title, raw)
		}
		if k.MinDuration > 0 && d < k.MinDuration {
			return "", fmt.Errorf("%s 不能小于 %s（收到 %s）", k.Title, k.MinDuration, d)
		}
		return d.String(), nil
	case KindCSV:
		parts := strings.Split(raw, ",")
		out := make([]string, 0, len(parts))
		seen := make(map[string]struct{}, len(parts))
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			if strings.ContainsAny(p, " \t\r\n") {
				return "", fmt.Errorf("%s 的每一项不能包含空白（收到 %q）", k.Title, p)
			}
			if _, dup := seen[p]; dup {
				continue // 去重是合法化，不是错误
			}
			seen[p] = struct{}{}
			out = append(out, p)
		}
		return strings.Join(out, ","), nil
	case KindChoice:
		for _, c := range k.Choices {
			if strings.EqualFold(strings.TrimSpace(c), raw) {
				return c, nil // 统一成注册表里的规范写法
			}
		}
		return "", fmt.Errorf("%s 只能是 %s 之一，收到 %q", k.Title, strings.Join(k.Choices, " / "), raw)
	default:
		return "", fmt.Errorf("%s 的 Kind=%q 未实现", k.Setting, k.Kind)
	}
}
