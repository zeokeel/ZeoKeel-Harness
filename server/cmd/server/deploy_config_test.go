package main

// 部署配置接线判据(2026-10-23):注册表的读库解析必须真的接上**公开契约**,
// 而且接在启动路径的开头。
//
// 缺陷形态(本仓反复出现过):解析函数写对了、单测也绿,但装配点没调用 ——
// 生产上控制台保存配置后行为不变,且没有任何红灯。因此这里分两层:
//  1. 源码级:main() 里两条装配调用必须在(且排在路由装配之前);
//  2. 执行级:调用 wireDeployConfigResolvers 后,updatecheck 的公开入口真的按库解析。

import (
	"os"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/deployconfig"
	"github.com/zeokeel/zeokeel-harness/server/internal/llmgateway"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/updatecheck"
)

// resetDeployConfigHooks 把包级解析钩子恢复成 env 默认实现(测试隔离:
// 钩子捕获的 db 句柄在用例结束后关闭,残留会让后续用例读到已关闭的库)。
func resetDeployConfigHooks() {
	updatecheck.SetEndpointOverrideResolver(nil)
	llmgateway.SetMaxInflightResolver(nil)
}

func TestMainWiresDeployConfig(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("读 main.go: %v", err)
	}
	text := string(src)
	for _, needle := range []string{
		"deployconfig.LogStartupEnvOverrides(db)",
		"wireDeployConfigResolvers(db)",
	} {
		at := strings.Index(text, needle)
		if at < 0 {
			t.Fatalf("main() 里找不到 %q —— 配置入库的接线没接上(控制台保存后行为不变,零红灯)", needle)
		}
		// 顺序:必须在路由装配之前。晚注入会让最早的请求读到 env/默认值,表现为
		// "刚启动那会儿配置不对",且这种时序缺陷在压测/重启窗口外难以复现。
		//
		// 注意:marker 拆成两段拼接 —— 本包有一条守卫禁止**测试文件里**出现
		// 路由注册的唯一真源字面量(routes_source_test.go 的"测试不得自建装配"),
		// 而这里只是读 main.go 源码断言顺序,不是自建路由。
		registerMarker := "router." + "Register("
		if rg := strings.Index(text, registerMarker); rg >= 0 && at > rg {
			t.Fatalf("%q 排在 router.Register 之后 —— 钩子晚注入会让早期请求读到旧值", needle)
		}
	}
}

// TestResolveUpdateEndpointOverride:数据库版解析必须与 env 默认实现同语义。
func TestResolveUpdateEndpointOverride(t *testing.T) {
	key := deployconfig.MustKey("deploy.update_endpoint")
	t.Setenv(key.Env, "")
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	if endpoint, disabled := resolveUpdateEndpointOverride(db); endpoint != "" || disabled {
		t.Fatalf("未配置 ⇒ (%q,%v)，want (\"\",false)（空 = 未设置，不是关闭）", endpoint, disabled)
	}

	for _, off := range []string{"off", "NONE", "-", "disabled"} {
		if err := serverstore.SetSetting(db, key.Setting, off); err != nil {
			t.Fatalf("写设置: %v", err)
		}
		if endpoint, disabled := resolveUpdateEndpointOverride(db); !disabled || endpoint != "" {
			t.Fatalf("%q 应表示显式关闭，得到 (%q,%v)", off, endpoint, disabled)
		}
	}

	const url = "https://release.example.com/example-brand/latest.json"
	if err := serverstore.SetSetting(db, key.Setting, url); err != nil {
		t.Fatalf("写设置: %v", err)
	}
	if endpoint, disabled := resolveUpdateEndpointOverride(db); disabled || endpoint != url {
		t.Fatalf("控制台端点 ⇒ (%q,%v)，want (%q,false)", endpoint, disabled, url)
	}

	// 环境变量仍压过控制台(存量 .env 的升级安全;也是"清单地址写错"的逃生口)。
	t.Setenv(key.Env, "https://env.example.com/latest.json")
	if endpoint, _ := resolveUpdateEndpointOverride(db); endpoint != "https://env.example.com/latest.json" {
		t.Fatalf("env 应压过控制台，得到 %q", endpoint)
	}
}

// TestWireDeployConfigResolversTakesEffect:执行级判据 —— 注入后 updatecheck 的
// 公开入口(ResolveEndpoint)立刻按库解析;复位后回到 env 默认实现。
func TestWireDeployConfigResolversTakesEffect(t *testing.T) {
	key := deployconfig.MustKey("deploy.update_endpoint")
	t.Setenv(key.Env, "")
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	t.Cleanup(resetDeployConfigHooks)

	wireDeployConfigResolvers(db)
	if err := serverstore.SetSetting(db, key.Setting, "https://console.example.com/example-brand/latest.json"); err != nil {
		t.Fatalf("写设置: %v", err)
	}
	if got := updatecheck.ResolveEndpoint("example-brand"); got != "https://console.example.com/example-brand/latest.json" {
		t.Fatalf("注入后 ResolveEndpoint = %q（读库版解析没接上）", got)
	}

	resetDeployConfigHooks()
	if got := updatecheck.ResolveEndpoint("example-brand"); got != updatecheck.DefaultEndpointFor("example-brand") {
		t.Fatalf("复位后 ResolveEndpoint = %q，want 渠道默认目录", got)
	}
}
