package deployconfig

import (
	"database/sql"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// Value 是一个配置项的**解析结果**（生效值 + 来源 + 两侧原始值）。
//
// 管理端「系统配置」页需要它：既要展示生效值，也要展示"它来自环境变量还是控制台还是
// 默认"，否则运维无法回答"我在控制台改了怎么没生效"。
type Value struct {
	Key Key
	// Raw 是生效值（已按 Kind 规范化）。未配置任何来源时 = 内置默认。
	Raw string
	// Source 是生效值的来源。
	Source Source
	// EnvSet 表示环境变量存在且非空（EnvRaw 是它的原始值）。
	EnvSet bool
	EnvRaw string
	// SettingSet 表示 settings 表里有这一行（SettingRaw 是它的原始值）。
	SettingSet bool
	SettingRaw string
	// Invalid 非空表示某个来源的取值非法（已回落；内容可直接展示给运维，含键名与原因）。
	// 读取路径不因它失败（"配置写错不该让服务端起不来"），但管理端保存路径会拒绝非法值，
	// 所以它主要是给日志与页面提示用的。
	Invalid string
}

// AsInt 把生效值转成 int（仅 KindInt；解析失败返回 0，调用方不应依赖它做校验）。
func (v Value) AsInt() int {
	n, _ := strconv.Atoi(v.Raw)
	return n
}

// AsBool 把生效值转成 bool。
func (v Value) AsBool() bool { return v.Raw == "true" }

// AsDuration 把生效值转成 time.Duration（KindDuration）。
func (v Value) AsDuration() time.Duration {
	d, _ := time.ParseDuration(v.Raw)
	return d
}

// AsCSV 把生效值拆成列表（空值返回 nil）。
func (v Value) AsCSV() []string {
	if strings.TrimSpace(v.Raw) == "" {
		return nil
	}
	parts := strings.Split(v.Raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// SetByEnv 报告生效值是否被环境变量覆盖（管理端据此给"改控制台不生效"的提示）。
func (v Value) SetByEnv() bool { return v.Source == SourceEnv }

// warnOnce 每个 (键, 原因) 只打一次 —— 这些读取在热路径上（每请求一次的限流检查），
// 每次都打会把日志淹掉；而"完全不告警"会让非法配置静默生效成默认值。
var warnOnce sync.Map // key: setting+"|"+reason -> struct{}

func warnf(key, reason, format string, args ...any) {
	k := key + "|" + reason
	if _, loaded := warnOnce.LoadOrStore(k, struct{}{}); loaded {
		return
	}
	log.Printf("deployconfig: "+format, args...)
}

// Resolve 解析一个配置项的生效值。
//
// 优先级：显式环境变量（非空）> settings 表 > 内置默认。
// db 可以为 nil（单机工具/测试）：此时跳过库，只看环境变量与默认值。
//
// 非法值的处理（与历史上各处的口径统一）：**回落**到下一个来源，并**各打一次**
// WARNING；绝不因为一个写错的配置让服务端起不来（启动闸门类键的 fail-closed 由
// 各自的装配点决定，见 Key.AppliesAt 与调用点注释）。
func Resolve(db *sql.DB, k Key) Value {
	v := Value{Key: k}

	// 1) 环境变量
	if k.Env != "" {
		if raw, ok := os.LookupEnv(k.Env); ok && strings.TrimSpace(raw) != "" {
			v.EnvSet = true
			v.EnvRaw = raw
		}
	}

	// 2) settings 表
	if db != nil {
		raw, ok, err := serverstore.GetSetting(db, k.Setting)
		if err != nil {
			warnf(k.Setting, "read", "读取设置 %s 失败（按未配置处理）：%v", k.Setting, err)
		} else if ok && strings.TrimSpace(raw) != "" {
			v.SettingSet = true
			v.SettingRaw = raw
		}
	}

	// 3) 逐级解析，第一个合法者生效
	if v.EnvSet {
		if canon, err := k.Parse(v.EnvRaw); err != nil {
			v.Invalid = "环境变量 " + k.Env + " 非法：" + err.Error()
			warnf(k.Setting, "env", "忽略非法的 %s=%q：%v", k.Env, v.EnvRaw, err)
		} else if canon != "" {
			v.Raw, v.Source = canon, SourceEnv
			return v
		}
	}
	if v.SettingSet {
		if canon, err := k.Parse(v.SettingRaw); err != nil {
			if v.Invalid == "" {
				v.Invalid = "控制台配置 " + k.Setting + " 非法：" + err.Error()
			}
			warnf(k.Setting, "setting", "忽略非法的设置 %s=%q：%v", k.Setting, v.SettingRaw, err)
		} else if canon != "" {
			v.Raw, v.Source = canon, SourceSetting
			return v
		}
	}
	// 4) 默认值（注册表自证：默认值必须可解析，见 keys_test.go）
	canon, err := k.Parse(k.Default)
	if err != nil {
		// 这是开发期错误（默认值写错），不是运维错误：大声打，仍然回落空串。
		warnf(k.Setting, "default", "内置默认值非法（这是 bug）：%s=%q：%v", k.Setting, k.Default, err)
		v.Raw = ""
	} else {
		v.Raw = canon
	}
	v.Source = SourceDefault
	return v
}

// Snapshot 按规范顺序解析全部注册项（管理端列表页 / 启动日志用）。
func Snapshot(db *sql.DB) []Value {
	keys := registry
	out := make([]Value, 0, len(keys))
	for _, k := range keys {
		out = append(out, Resolve(db, k))
	}
	return out
}

// EnvOverridden 返回**生效值来自环境变量**的键名列表（规范顺序）。
//
// 用途有两个：启动日志点名"这些值来自 .env，控制台改了不生效"；管理端保存时把
// 同一份名单作为 warning 返回 —— 让"保存成功但没生效"永远带线索。
func EnvOverridden(db *sql.DB) []string {
	var out []string
	for _, k := range registry {
		if Resolve(db, k).SetByEnv() {
			out = append(out, k.Setting)
		}
	}
	return out
}

// LogStartupEnvOverrides 在启动时打印一次"环境变量覆盖了控制台配置"的清单。
//
// 为什么必须是启动期一行可检索的日志：容器重建后 .env 仍然是旧的，运维很可能已经
// 在控制台改过同一个键 —— 不点名就会变成"改了不生效"却无迹可查（本仓登记过的
// 多次审计缺陷形态）。**不打印取值**（这些键大多不是秘密，但统一纪律：日志只给键名）。
func LogStartupEnvOverrides(db *sql.DB) {
	names := EnvOverridden(db)
	if len(names) == 0 {
		return
	}
	log.Printf("deployconfig: 以下配置来自环境变量（优先于控制台配置；如需在控制台调整请先删除 .env 中的对应行）：%s",
		strings.Join(names, ", "))
}

// 便捷读取器：热路径用（settings 有 30s TTL 缓存 + 写失效，不会造成每请求一次库往返）。

// String 返回字符串类配置的生效值。
func String(db *sql.DB, k Key) string { return Resolve(db, k).Raw }

// Int 返回整数类配置的生效值（非法/未配置时回落到注册表默认值）。
func Int(db *sql.DB, k Key) int { return Resolve(db, k).AsInt() }

// Bool 返回布尔类配置的生效值。
func Bool(db *sql.DB, k Key) bool { return Resolve(db, k).AsBool() }

// Duration 返回时长类配置的生效值。
func Duration(db *sql.DB, k Key) time.Duration { return Resolve(db, k).AsDuration() }

// CSV 返回逗号分隔类配置的生效值。
func CSV(db *sql.DB, k Key) []string { return Resolve(db, k).AsCSV() }

// MustKey 按键名取注册项；未知键 panic（只用于编译期已知字面量的调用点）。
func MustKey(setting string) Key {
	k, ok := BySetting(setting)
	if !ok {
		panic("deployconfig: 未注册的配置键 " + setting)
	}
	return k
}
