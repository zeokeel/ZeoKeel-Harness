// 本文件是「**应用级**限流覆盖」的校验与解析（决策
// docs/decisions/2026-10-22-wasm-per-app-limits.md §2.1）。
//
// 取值类型住在叶子包 `limits`（`limits.AppOverride`，四个 int + 0=继承），
// 这里以**别名**暴露：`applimits.AppOverride` 与 `limits.AppOverride` 是**同一个类型**
// （方法集/JSON 键/相等口径完全同一份）。为什么不让类型住在本包：applimits → readyz →
// queue 已经是既有依赖链，而 queue 必须持有覆盖表 ⇒ 类型若声明在本包，queue 会与本包
// 形成导入环（见 limits/appoverride.go 的头注释）。
//
// 本文件只做三件事（不产生第二套规则）：
//  1. `ApplyOverride`：全局 Limits 复制后套用非空覆盖（0 = 继承）；
//  2. `ValidateOverride`：**复用 Limits.Validate()** 判"全局 + 覆盖"的整体组合
//     （含 user_per_app_running ≤ app_running、app_running ≤ max_instances 等），
//     只额外补可操作 hint 与 global/effective 明细；
//  3. `ParseOverride`：解析管理端 PUT body（未知键 fail-loud、null/空 = 清空/继承）。
package applimits

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
)

// AppOverride 是 `limits.AppOverride` 的**别名**（同一个类型：字段、方法、JSON 键同一份）。
//
// 0 = 继承全局；`AppOverride{}` = 无覆盖。取值类型的实现与理由见
// internal/limits/appoverride.go。
type AppOverride = limits.AppOverride

// AppOverrideFieldNames 转发字段名清单（唯一真源在 limits 包）。
func AppOverrideFieldNames() []string { return limits.AppOverrideFieldNames() }

// ApplyOverride 返回"全局限制项 + 本应用覆盖"的**生效值**。
//
// 纯函数：不校验（校验走 `ValidateOverride`）。0 = 该轴继承全局；继承的**子轴**在父轴
// 被收紧时向下钳到父轴（规则与理由见 `limits.Axes.Resolve`：`app_running=1` 必须能把
// 继承来的 `user_per_app_running=2` 一起收成 1，否则"把某个应用降成串行"这种最常用的
// 收紧会被判成非法组合）。除四轴外的字段原样保留（per-app 不做内存/时间预算）。
func ApplyOverride(global Limits, ov AppOverride) Limits {
	axes := limits.Axes{
		AppRunning:        global.AppRunning,
		AppQueue:          global.AppQueue,
		UserPerAppRunning: global.UserPerAppRunning,
		UserPerAppQueued:  global.UserPerAppQueued,
	}.Resolve(ov)
	eff := global
	eff.AppRunning = axes.AppRunning
	eff.AppQueue = axes.AppQueue
	eff.UserPerAppRunning = axes.UserPerAppRunning
	eff.UserPerAppQueued = axes.UserPerAppQueued
	return eff
}

// OverrideExceedsGlobal 报告哪些轴**高于**全局值（API 的 `exceeds_global` 提示）。
//
// 它是**提示不是判据**：决策 §2.1 明确允许管理员把某个应用调得比全局高（"该应用会比
// 其他应用占用更多槽位"由 UI 二次确认），这里只负责把事实算出来。
// 返回的键是字段名（与 AppOverrideFieldNames 同口径），值为 true 表示该轴高于全局。
func OverrideExceedsGlobal(global Limits, o AppOverride) map[string]bool {
	return map[string]bool{
		"app_running":          o.AppRunning > 0 && o.AppRunning > global.AppRunning,
		"app_queue":            o.AppQueue > 0 && o.AppQueue > global.AppQueue,
		"user_per_app_running": o.UserPerAppRunning > 0 && o.UserPerAppRunning > global.UserPerAppRunning,
		"user_per_app_queued":  o.UserPerAppQueued > 0 && o.UserPerAppQueued > global.UserPerAppQueued,
	}
}

// Validate 校验"全局 + 这份覆盖"的组合，返回可直接回控制台的信封。
//
// 判据**全部复用 `Limits.Validate()`**（决策 §2.1：per-app 组合与全局保存走同一份判据，
// 含跨字段关系），本函数只做两件 `Validate` 做不到的事：
//   - 把 `details.field` 上的字段补一条**可操作 hint**：全局值是多少、允许范围是多少、
//     该应用的生效值是多少（管理员改一个数字时要能直接落笔）；
//   - 把 `global` / `effective` 两组数值放进 details（前端展示"改完会变成什么"）。
func ValidateOverride(global Limits, o AppOverride) *apperr.Error {
	// 负值先判：0 是"继承"哨兵，但 -1 是走样输入 —— 如果直接进 ApplyOverride，
	// `> 0` 的判据会把 -1 静默当成"继承"，管理员以为设了值、实际什么都没改
	//（这正是本仓反复清理的 fail-open 形态）。所以负数一律拒，并点名到字段。
	for _, f := range AppOverrideFieldNames() {
		if v := o.Value(f); v < 0 {
			lo, hi, _ := overrideFieldRange(global, global, f)
			return apperr.New(apperr.CodeValidation,
				"限流覆盖的 "+f+" 必须是正整数（留空/0 = 继承全局，不能是负数）").
				WithDetail("field", f).
				WithDetail("value", v).
				WithDetail("global", overrideAxisMap(global)).
				WithDetail("effective", overrideAxisMap(global)).
				WithHint(fmt.Sprintf("该应用的 %s 允许范围是 %d–%d（全局值 %d，本应用生效值继承全局）；"+
					"%s 表示该应用的并发/队列个数，要恢复继承全局请传 null、0 或删掉这个键",
					f, lo, hi, overrideAxisValue(global, f), f))
		}
	}
	eff := ApplyOverride(global, o)
	err := eff.Validate()
	if err == nil {
		return nil
	}
	field, _ := err.Details["field"].(string)
	if field == "" {
		field = "app_override"
	}
	if lo, hi, ok := overrideFieldRange(global, eff, field); ok {
		err.WithHint(fmt.Sprintf("该应用的 %s 允许范围是 %d–%d（全局值 %d，本应用生效值 %d）",
			field, lo, hi, overrideAxisValue(global, field), overrideAxisValue(eff, field)))
	}
	err.WithHint(fmt.Sprintf("全局值：app_running=%d / app_queue=%d / user_per_app_running=%d / user_per_app_queued=%d",
		global.AppRunning, global.AppQueue, global.UserPerAppRunning, global.UserPerAppQueued))
	err.WithDetail("global", overrideAxisMap(global))
	err.WithDetail("effective", overrideAxisMap(eff))
	return err
}

// overrideAxisMap 把 Limits 折成四个并发轴的 map（details 展示用；与视图同键名）。
func overrideAxisMap(l Limits) map[string]int {
	return map[string]int{
		"app_running":          l.AppRunning,
		"app_queue":            l.AppQueue,
		"user_per_app_running": l.UserPerAppRunning,
		"user_per_app_queued":  l.UserPerAppQueued,
	}
}

// overrideAxisValue 读某字段在给定 Limits 上的值（未知字段返回 0）。
func overrideAxisValue(l Limits, field string) int {
	switch field {
	case "app_running":
		return l.AppRunning
	case "app_queue":
		return l.AppQueue
	case "user_per_app_running":
		return l.UserPerAppRunning
	case "user_per_app_queued":
		return l.UserPerAppQueued
	}
	return 0
}

// overrideFieldRange 返回某字段在本组合下的**允许区间**（与 Validate 同一批常量）。
//
// ⚠️ 上界用**生效值**（不是全局值）：`user_per_app_running ≤ app_running` 里的
// app_running 是"这个应用"的（可能已被覆盖），提示必须说这个应用能填到多少。
func overrideFieldRange(global, eff Limits, field string) (lo, hi int, ok bool) {
	switch field {
	case "app_running":
		return 1, global.MaxInstances, true
	case "app_queue":
		return 1, MaxAppQueue, true
	case "user_per_app_running":
		return 1, eff.AppRunning, true
	case "user_per_app_queued":
		return 1, eff.AppQueue, true
	}
	return 0, 0, false
}

// ParseOverride 解析管理端 PUT 的请求体（**严格**：未知键 fail-loud）。
//
// 语义（决策 §2.3）：
//   - `null` / 空 body / `{}` ⇒ 无覆盖（= 清空），`cleared=true`；
//   - 键出现且值为 `null` ⇒ 该轴继承（与"不写这个键"同义）；
//   - 键出现且值为整数 ⇒ 该轴覆盖；**`0` 表示继承**（与 null/不写同义，四轴全 0 = 清空），
//     负数交给 ValidateOverride 拒（不在这里静默丢弃）。
//
// 为什么必须逐键解析（而不是 `json.Unmarshal` 到一个结构体）：结构体解码会把
// `"app_running":"2"`（字符串）报成一句与字段无关的语法错误，管理员看不到
// `details.field`；而 `DisallowUnknownFields` 又要多一层 decoder 配置。这里先按
// **键集合**判定（与全局 limits 信封同一纪律），再逐键取值，错误永远点名到字段。
func ParseOverride(raw []byte) (AppOverride, bool, *apperr.Error) {
	s := bytes.TrimSpace(raw)
	if len(s) == 0 || bytes.Equal(s, []byte("null")) {
		return AppOverride{}, true, nil
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(s, &probe); err != nil {
		return AppOverride{}, false, apperr.New(apperr.CodeValidation, "限流覆盖必须是 JSON 对象或 null").
			WithDetail("reason", err.Error()).
			WithHint(`body 形如 {"app_running":2,"app_queue":16}；null / {} 表示清空覆盖（回到全局值）`)
	}
	known := make(map[string]struct{}, len(AppOverrideFieldNames()))
	for _, f := range AppOverrideFieldNames() {
		known[f] = struct{}{}
	}
	unknown := make([]string, 0, len(probe))
	for k := range probe {
		if _, ok := known[k]; !ok {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return AppOverride{}, false, apperr.New(apperr.CodeValidation,
			"限流覆盖含未知字段："+unknown[0]).
			WithDetail("field", unknown[0]).
			WithDetail("allowed", AppOverrideFieldNames()).
			WithHint("覆盖只接受四个键：" + fmt.Sprintf("%v", AppOverrideFieldNames()) +
				"；未知键会被拒（拼错字段名会让改动静默不生效），其余限流字段走全局 PUT /wasm-apps/limits")
	}
	var ov AppOverride
	for _, f := range AppOverrideFieldNames() {
		rawValue, ok := probe[f]
		if !ok {
			continue
		}
		trimmed := bytes.TrimSpace(rawValue)
		if bytes.Equal(trimmed, []byte("null")) {
			continue // 显式 null = 继承（与不写同义）
		}
		var v int
		if err := json.Unmarshal(trimmed, &v); err != nil {
			return AppOverride{}, false, apperr.New(apperr.CodeValidation,
				"限流覆盖的 "+f+" 必须是整数或 null").
				WithDetail("field", f).
				WithDetail("reason", err.Error()).
				WithHint(f + " 是整数字段（并发/队列个数）；要恢复继承全局请传 null / 0 / 删掉这个键")
		}
		switch f {
		case "app_running":
			ov.AppRunning = v
		case "app_queue":
			ov.AppQueue = v
		case "user_per_app_running":
			ov.UserPerAppRunning = v
		case "user_per_app_queued":
			ov.UserPerAppQueued = v
		}
	}
	if ov.IsZero() {
		// `{}` 与"四个键全 null"都是清空：两者在语义上都是"没有任何覆盖"，
		// 响应与审计不该因为它们形态不同而不同（决策 §2.3：空对象 = 清空）。
		return AppOverride{}, true, nil
	}
	return ov, false, nil
}
