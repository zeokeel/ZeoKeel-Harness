//go:build apps

package main

// 三个启动闸门键的**解析口径**判据（2026-10-23，部署配置入库）。
//
// 为什么单测这些纯函数而不是跑 setupWasmPlatform：后者要真 PG + 真编译子进程 +
// 内存水位，且内存档位错了会 log.Fatalf —— 那正是我们要断言的分支，没法在执行级
// 用例里覆盖 "非法值 ⇒ 返回 error"。装配点只保留一行"拿到 error 就 Fatalf"的
// 接线（由 TestWasmPlatformWiringPresent 的源码判据兜住）。

import (
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/deployconfig"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/compile"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/memprofile"
)

func TestResolveWasmMemoryProfile(t *testing.T) {
	key := deployconfig.MustKey("wasm.memory_profile")
	t.Setenv(key.Env, "")

	// 未配置 = 默认档，且来源标记为"未显式配置"（wasm 限制项据此显示"编译期默认"）。
	prof, explicit, err := resolveWasmMemoryProfile(nil)
	if err != nil {
		t.Fatalf("未配置时不应报错: %v", err)
	}
	if prof != memprofile.Default() || explicit {
		t.Fatalf("未配置时 = %+v explicit=%v，want 默认档且未显式配置", prof, explicit)
	}

	// 历史环境变量仍覆盖（存量 .env 的升级安全；也是启动自检失败时的逃生口）。
	t.Setenv(key.Env, "small")
	prof, explicit, err = resolveWasmMemoryProfile(nil)
	if err != nil || prof != memprofile.Small() || !explicit {
		t.Fatalf("env=small ⇒ %+v explicit=%v err=%v，want small 且显式", prof, explicit, err)
	}

	// 控制台保存的档位生效（配置入库的核心承诺），且 env 仍压过它。
	t.Setenv(key.Env, "")
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	if err := serverstore.SetSetting(db, key.Setting, "large"); err != nil {
		t.Fatalf("写设置: %v", err)
	}
	prof, explicit, err = resolveWasmMemoryProfile(db)
	if err != nil || prof != memprofile.Large() || !explicit {
		t.Fatalf("控制台=large ⇒ %+v explicit=%v err=%v，want large 且显式", prof, explicit, err)
	}
	t.Setenv(key.Env, "small")
	if prof, _, err = resolveWasmMemoryProfile(db); err != nil || prof != memprofile.Small() {
		t.Fatalf("env 应压过控制台：%+v err=%v", prof, err)
	}

	// 未知档位**拒绝启动**（fail-loud 是本键的历史语义：静默回落会让小机器 OOM）。
	t.Setenv(key.Env, "huge")
	if _, _, err := resolveWasmMemoryProfile(db); err == nil {
		t.Fatal("未知档位必须返回错误（装配点据此 log.Fatalf），不得静默回落")
	} else if !strings.Contains(err.Error(), "wasm.memory_profile") &&
		!strings.Contains(err.Error(), "内存档位") {
		t.Fatalf("错误信息必须点名配置项：%v", err)
	}
}

func TestResolveCompileIsolation(t *testing.T) {
	key := deployconfig.MustKey("wasm.compile_isolation")
	t.Setenv(key.Env, "")

	if got := resolveCompileIsolation(nil); got != compile.IsolationAuto {
		t.Fatalf("未配置 = %v，want auto(历史默认)", got)
	}
	t.Setenv(key.Env, "require")
	if got := resolveCompileIsolation(nil); got != compile.IsolationRequire {
		t.Fatalf("env=require ⇒ %v，want require", got)
	}

	// 控制台设置生效，env 仍压过控制台。
	t.Setenv(key.Env, "")
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	if err := serverstore.SetSetting(db, key.Setting, "off"); err != nil {
		t.Fatalf("写设置: %v", err)
	}
	if got := resolveCompileIsolation(db); got != compile.IsolationOff {
		t.Fatalf("控制台=off ⇒ %v，want off(控制台保存未生效)", got)
	}
	t.Setenv(key.Env, "require")
	if got := resolveCompileIsolation(db); got != compile.IsolationRequire {
		t.Fatalf("env 应压过控制台：%v，want require", got)
	}

	// 历史别名 strict / none：注册表的候选集只认规范三值，但存量 .env 里可能写着
	// 别名 —— 直接被注册表判非法并回落会把 require 静默降成 auto（等于关掉加固）。
	t.Setenv(key.Env, "strict")
	if got := resolveCompileIsolation(db); got != compile.IsolationRequire {
		t.Fatalf("历史别名 strict ⇒ %v，want require(不得静默降级为 auto)", got)
	}
	t.Setenv(key.Env, "none")
	if got := resolveCompileIsolation(db); got != compile.IsolationOff {
		t.Fatalf("历史别名 none ⇒ %v，want off", got)
	}

	// 真·垃圾值：两个解析器都拒绝 ⇒ 回落（不阻止启动，与历史一致）。
	t.Setenv(key.Env, "garbage")
	if got := resolveCompileIsolation(db); got != compile.IsolationOff {
		// 控制台里存的是 off，非法 env 被忽略后应回落到控制台值。
		t.Fatalf("垃圾 env ⇒ %v，want 回落控制台 off", got)
	}
}
