package appserver

// C-10（审计 2026-10-22，P2）：运行期**水位出口**的判据。
//
// 现场：限额控制台可以调 `module_cache_mb` / `app_db_readers`，但运行期没有任何出口
// 能回答"现在真的用了多少" —— 管理面 `/admin/wasm-apps/runtime` 把 module_cache 与
// appdb_handles 归进 `unavailable`（代码自认没有访问器）。这里钉住三件事：
//
//  1. 两个访问器在**空载**时给出**真上限**（来自 limits/profile 的注入值，不是 0）；
//  2. 真的跑过一次请求之后，条目/字节/句柄数**跟着涨**（说明它们读的是活对象，
//     不是某份构造期快照）；
//  3. `EvictApp` 之后回到 0（事件驱动释放的可观测性 —— 与 CachedModuleCount 同一条理由：
//     没有它，"钩子到底有没有接到 appserver 上"只能退化成源码字符串断言）；
//  4. nil 接收者返回零值（api 侧的"未装配 ⇒ unavailable"依赖这个契约，不能 panic）。
//
// 变异验证：
//   - 让 ModuleCacheStats 返回 `moduleCache{}` 的零值（不读真对象）⇒ 第 2 条红；
//   - 让 AppDBPoolStats 恒报 Handles=0 ⇒ 第 2/3 条红；
//   - 让 EvictApp 不回收句柄 ⇒ 第 3 条红（这条同时守着"下架/冻结/删除即时释放"）。

import (
	"net/http"
	"testing"
)

func TestServerStatsExposeModuleCacheAndAppDBPool(t *testing.T) {
	e := newEnv(t)

	// ① 空载：上限必须是真值（来自 limits，不是 0 —— 0 会被管理面读成"没有上限"）。
	mod := e.srv.ModuleCacheStats()
	if mod.MaxBytes <= 0 || mod.MaxEntries <= 0 || mod.IdleTTL <= 0 {
		t.Fatalf("空载时上限必须是真值: %+v", mod)
	}
	if mod.Entries != 0 || mod.CompiledEntries != 0 || mod.Bytes != 0 {
		t.Fatalf("空载时占用应为 0（条目/编译产物/字节）: %+v", mod)
	}
	pool := e.srv.AppDBPoolStats()
	if pool.Max <= 0 {
		t.Fatalf("句柄池上限必须是真值: %+v", pool)
	}
	if pool.Handles != 0 {
		t.Fatalf("空载时不应持有句柄: %+v", pool)
	}

	// ④ nil 接收者：零值而不是 panic（api 的"未装配"分支依赖它）。
	var nilSrv *Server
	if got := nilSrv.ModuleCacheStats(); got != (ModuleCacheStats{}) {
		t.Fatalf("nil Server 的 ModuleCacheStats 应为零值: %+v", got)
	}
	if got := nilSrv.AppDBPoolStats(); got != (AppDBPoolStats{}) {
		t.Fatalf("nil Server 的 AppDBPoolStats 应为零值: %+v", got)
	}

	// ② 跑一次入口请求：模块（或资源集）与库句柄都应被真实占用。
	spec := appSpec{appID: e.appID("stats"), config: loginConfig()}
	e.publishApp(spec)
	if rec := e.get(spec.appID, "/"); rec.Code != http.StatusOK {
		t.Fatalf("入口请求失败: %d %s", rec.Code, rec.Body.String())
	}
	mod = e.srv.ModuleCacheStats()
	if mod.Entries < 1 || mod.Bytes <= 0 {
		t.Fatalf("执行过一次后模块缓存应被占用: %+v", mod)
	}
	if mod.CompiledEntries > mod.Entries {
		t.Fatalf("已编译条目数不能超过条目数: %+v", mod)
	}
	pool = e.srv.AppDBPoolStats()
	if pool.Handles < 1 {
		t.Fatalf("执行过一次后应持有一个应用库句柄: %+v", pool)
	}

	// ③ EvictApp（下架/冻结/删除的事件驱动释放）之后回到 0。
	e.srv.EvictApp(spec.appID)
	mod = e.srv.ModuleCacheStats()
	if mod.Entries != 0 || mod.CompiledEntries != 0 || mod.Bytes != 0 {
		t.Fatalf("EvictApp 之后模块缓存应清空: %+v", mod)
	}
	pool = e.srv.AppDBPoolStats()
	if pool.Handles != 0 {
		t.Fatalf("EvictApp 之后不应再持有句柄: %+v", pool)
	}
	// 上限不受释放影响（释放的是占用，不是配置）。
	if mod.MaxBytes != e.srv.ModuleCacheStats().MaxBytes || pool.Max < 1 {
		t.Fatalf("释放不应改动上限: mod=%+v pool=%+v", mod, pool)
	}
}
