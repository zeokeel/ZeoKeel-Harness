//go:build apps

// 本文件属于 `apps` 模块（P1 第二片，2026-10-14）：它引用 `internal/wasmapp/**`
// 的类型，关闭 apps 时整份不编译（关闭态的接线在 optional_apps_off.go 里不适用 ——
// 平台本身不装配，这些解析函数也就没有消费者）。
//
// 为什么单独一个文件：这三个键都是**启动闸门**，解析口径（谁回落、谁 fail-loud、
// 历史别名怎么兼容）本身需要被测试直接钉住，而 setupWasmPlatform 要真 PG + 真
// 编译子进程，没有执行级接缝。把它们抽成纯函数后，判据可以只喂 db 断言结果。

package main

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/zeokeel/zeokeel-harness/server/internal/deployconfig"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/compile"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/memprofile"
)

// resolveCompileIsolation 解析 `wasm.compile_isolation` 的生效档。
//
// 语义与历史 IsolationFromEnv 一致：未知值**不阻止启动**（加固开关写错不该让
// 服务起不来；deployconfig 已按统一口径告警并回落到默认 auto）。
//
// 唯一需要额外处理的是**历史别名**：注册表的 KindChoice 只认 require / auto / off，
// 而旧解析器还接受 strict / none（旧注释里就写着）。若直接吃 Resolve 的规范化值，
// 存量 .env 写着 `strict` 的部署会从 require **静默降级**成 auto —— 等于悄悄关掉了
// fail-closed 加固。因此当显式来源被判非法时，按来源优先级（env → setting）用
// 同一个 ParseIsolation 再宽容解析一次；真·垃圾值两个解析器都拒绝，仍然回落默认。
func resolveCompileIsolation(db *sql.DB) compile.IsolationMode {
	v := deployconfig.Resolve(db, wasmCompileIsolationKey)
	if v.Invalid != "" {
		explicit := []struct {
			set bool
			raw string
		}{
			{v.EnvSet, v.EnvRaw},
			{v.SettingSet, v.SettingRaw},
		}
		for _, src := range explicit {
			if !src.set {
				continue
			}
			if mode, err := compile.ParseIsolation(src.raw); err == nil {
				return mode
			}
		}
	}
	mode, err := compile.ParseIsolation(v.Raw)
	if err != nil {
		// 注册表默认值自证可解析（keys_test.go），走到这里说明注册表被改坏：
		// 兜底 auto 而不是 panic —— 隔离档的未知值历史上就允许回落。
		return compile.IsolationAuto
	}
	return mode
}

// resolveWasmMemoryProfile 解析 `wasm.memory_profile` 的生效档位。
//
// 与隔离档不同，内存档位的历史语义是**fail-loud**：未知档位名拒绝启动。理由
// （见 memprofile.Parse 的注释）：静默回落默认会让一台小机器在"以为已经降到
// small"的状态下按 default 的账本启动（或被反过来按 small 限流），两种都是无声的
// 容量事故。deployconfig 已经按统一口径告警并回落，这里把"有人写了非法值"这一
// 事实升级成启动失败，保持原有闸门语义。
//
// 第二个返回值 = "档位是否被显式配置"（env 或控制台）：wasm 限制项的来源标签
// 需要它（未配置 ⇒ 编译期默认，显式配了 default ⇒ 部署档位），见
// wasmLimitsHolder.profileSource。
func resolveWasmMemoryProfile(db *sql.DB) (memprofile.Profile, bool, error) {
	v := deployconfig.Resolve(db, wasmMemoryProfileKey)
	if v.Invalid != "" {
		return memprofile.Profile{}, false, errors.New(v.Invalid)
	}
	prof, err := memprofile.Parse(v.Raw)
	if err != nil {
		return memprofile.Profile{}, false, fmt.Errorf("%s", err.Error())
	}
	return prof, v.Source != deployconfig.SourceDefault, nil
}
