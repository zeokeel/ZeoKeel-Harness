//go:build apps

// 本文件属于 `apps` 模块：启动期把库里的**应用级限流覆盖**装进队列。

package main

import (
	"context"
	"database/sql"
	"log"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/applimits"
)

// wasmAppLimitLoader 是"把一组覆盖整表装进调度器"的最小依赖面
// （`*queue.Scheduler` 满足它：`SetAppLimitOverrides(map[string]limits.AppOverride)`）。
//
// 抽成函数类型而不是直接写 `scheduler.SetAppLimitOverrides(...)` 调用，是为了让
// **装配级判据**能用记账替身断言"启动时真的调了它、收到的条目是什么" —— 只 grep
// 源码里有那一行分不清"调了但传的是空表"（本仓对"接上了但值是错的"有明确纪律）。
type wasmAppLimitLoader func(overrides map[string]limits.AppOverride)

// loadWasmAppLimitOverrides 从 `wasm_app_limits` 读全量覆盖并整表装进调度器
// （决策 docs/decisions/2026-10-22-wasm-per-app-limits.md §2.2 / §2.6 第 6 条）。
//
// 三条语义：
//  1. **整表替换**（不是合并）：它服务"进程启动"这一条路径，合并语义会让库里删掉的
//     覆盖在重启后继续存活（管理员清不掉的黑配置）。
//  2. **按当前全局值校验**（applimits.ValidateOverride）：覆盖是"在保存那一刻合法"的，
//     而全局值之后可能被改小（app_running / max_instances），存进库的组合可能已经非法。
//     非法条目**跳过并 warn**（不是拒绝启动、也不是照单全收）—— 跳过只会让该应用回到
//     全局值（更紧），而照单全收会让"库里的旧覆盖"绕过全局收紧。
//  3. **读失败只返回错误、不 panic/不 Fatalf**：调用方（setupWasmPlatform）按
//     "不阻断启动"处理 —— 覆盖读不出来时平台按全局值服务，比整个服务端起不来好。
//
// 返回真正装载的条目数（被跳过的非法条目不计入，但会逐条进日志）。
func loadWasmAppLimitOverrides(ctx context.Context, db *sql.DB, global applimits.Limits, load wasmAppLimitLoader) (int, error) {
	rows, err := serverstore.ListWasmAppLimitOverrides(ctx, db)
	if err != nil {
		return 0, err
	}
	out := make(map[string]limits.AppOverride, len(rows))
	for _, rec := range rows {
		ov := limits.AppOverride{
			AppRunning:        intOrZeroValue(rec.AppRunning),
			AppQueue:          intOrZeroValue(rec.AppQueue),
			UserPerAppRunning: intOrZeroValue(rec.UserPerAppRunning),
			UserPerAppQueued:  intOrZeroValue(rec.UserPerAppQueued),
		}
		if ov.IsZero() {
			// DAO 已经过滤了"四列全 NULL"的历史行；这里再兜一层是为了让"整表装载"
			// 不依赖读取侧实现（零值条目对调度器而言就是"没有覆盖"，但它在 map 里
			// 会让 AppLimitOverrideCount 说谎）。
			continue
		}
		if verr := applimits.ValidateOverride(global, ov); verr != nil {
			log.Printf("wasm: ⚠️ 应用 %s 的限流覆盖按当前全局值已非法，本次启动跳过（该应用按全局值判定）：%v %+v",
				rec.AppID, verr, ov)
			continue
		}
		out[rec.AppID] = ov
	}
	load(out)
	return len(out), nil
}

// intOrZeroValue 解引用可空整数（nil ⇒ 0 = 继承）。与 api 包的同名逻辑同义，
// 但两侧分属不同模块（cmd/server 与 internal/wasmapp/api），不共享一个 internal 助手
// 只为两行代码；语义由 serverstore 的 NULL=继承 定义，两处都只是解引用。
func intOrZeroValue(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}

// reconcileWasmAppLimitOverrides 在**全局限制项变化**时重新校验在册的 per-app 覆盖
// （2026-10-22 反证 F-6）：全局 `max_instances` / `app_running` 被调小之后，库里的旧覆盖
// 可能已经非法（例如覆盖 app_running=4 而新的 max_instances=3）。启动路径已经按当前全局值
// 校验并跳过非法条目，但**运行期**改全局不会重跑这一步 —— 那些覆盖会继续留在内存里，
// 并且 GET 视图用 `ApplyOverride` 算出的 effective 与调度器实际判定可能出现分叉。
//
// 语义（fail-closed）：
//   - 非法条目 **从库里删除**（否则下次启动还会被跳过、GET 视图继续展示一个不生效的覆盖）；
//   - 写一条 `wasm_app_limits_change` 审计（actor=system，detail 说明"全局收紧后清理"）；
//   - 合法条目整表重新下发（`load` 是替换语义，删掉的条目不会残留）。
//
// 返回被清理的条目数。读失败返回错误，调用方只 warn（不阻断限制项保存）。
func reconcileWasmAppLimitOverrides(ctx context.Context, db *sql.DB, global applimits.Limits,
	load wasmAppLimitLoader) (int, error) {
	rows, err := serverstore.ListWasmAppLimitOverrides(ctx, db)
	if err != nil {
		return 0, err
	}
	valid := make(map[string]limits.AppOverride, len(rows))
	cleared := 0
	for _, rec := range rows {
		ov := limits.AppOverride{
			AppRunning:        intOrZeroValue(rec.AppRunning),
			AppQueue:          intOrZeroValue(rec.AppQueue),
			UserPerAppRunning: intOrZeroValue(rec.UserPerAppRunning),
			UserPerAppQueued:  intOrZeroValue(rec.UserPerAppQueued),
		}
		if ov.IsZero() {
			continue
		}
		if verr := applimits.ValidateOverride(global, ov); verr != nil {
			if _, cerr := serverstore.ClearWasmAppLimitOverride(ctx, db, rec.AppID); cerr != nil {
				log.Printf("wasm: ⚠️ 应用 %s 的限流覆盖在全局收紧后已非法、清理失败（该应用仍按全局值判定）: %v", rec.AppID, cerr)
				continue
			}
			cleared++
			log.Printf("wasm: ⚠️ 应用 %s 的限流覆盖在全局收紧后已非法，已清除（回到全局值）: %v", rec.AppID, verr)
			detail := "限流覆盖（全局限制项变更后校验失败，已清除并回到继承全局） actor=system actor_role=system"
			if aerr := serverstore.AuditLogApp(db, rec.AppID, "system", "wasm_app_limits_change", detail); aerr != nil {
				log.Printf("wasm: ⚠️ 记录限流覆盖清理审计失败（app=%s）: %v", rec.AppID, aerr)
			}
			continue
		}
		valid[rec.AppID] = ov
	}
	load(valid)
	return cleared, nil
}
