package main

// 本文件是「部署配置入库」（internal/deployconfig 注册表）在**进程装配层**的接线。
//
// 为什么接线集中在这里、而不是让每个业务包各拿一个 *sql.DB:
//   - 这两条配置的读取点（更新清单地址、单用户并发上限）都在**公开契约**上
//     （ResolveEndpoint 被 main / server-info / Checker.Check 共用；InFlightGuard
//     由 internal/router 的包级中间件构造），给它们加 db 参数会把存储依赖扩散到
//     路由层与每个调用点；
//   - 业务包只暴露一个"取生效值"的解析钩子，装配方在启动期注入一次，职责边界清晰：
//     业务包不知道 settings 表，装配层不知道业务语义。
//
// 与 deployconfig.LogStartupEnvOverrides 的分工：那个负责"哪些键被环境变量压住了"
// 的启动期可检索日志（否则控制台改了不生效没有线索），这里负责让**读库解析**真的
// 接上热路径。两者缺一都会退化成"控制台保存成功、行为不变"。

import (
	"database/sql"

	"github.com/zeokeel/zeokeel-harness/server/internal/deployconfig"
	"github.com/zeokeel/zeokeel-harness/server/internal/llmgateway"
	"github.com/zeokeel/zeokeel-harness/server/internal/updatecheck"
)

// wireDeployConfigResolvers 把"读库版"解析注入到各包的解析钩子。main 在 DB 打开
// 后、任何请求路径开始之前调用一次。
func wireDeployConfigResolvers(db *sql.DB) {
	// 更新清单地址：deploy.update_endpoint(环境变量 ZEOKEEL_UPDATE_ENDPOINT 仍
	// 是最高优先级的覆盖口 —— 存量 .env 的升级安全)。
	updatecheck.SetEndpointOverrideResolver(func() (string, bool) {
		return resolveUpdateEndpointOverride(db)
	})
	// 单用户并发上限：gateway.max_inflight_per_user。
	llmgateway.SetMaxInflightResolver(func() int {
		return deployconfig.Int(db, deployconfig.MustKey("gateway.max_inflight_per_user"))
	})
}

// resolveUpdateEndpointOverride 解析 `deploy.update_endpoint` 的**显式**覆盖。
//
// 语义必须与 updatecheck 的 env 默认实现逐字一致(复用同一份判断，避免两个来源
// 各有一套"什么算关闭"):
//   - 未配置(settings 无行、env 空) ⇒ ("", false) 表示未设置，不是关闭；
//   - off / none / - / disabled ⇒ ("", true) 显式关闭更新检查；
//   - 其它 ⇒ 原样作为清单地址。
func resolveUpdateEndpointOverride(db *sql.DB) (string, bool) {
	v := deployconfig.Resolve(db, deployconfig.MustKey("deploy.update_endpoint"))
	return updatecheck.InterpretEndpointOverride(v.Raw)
}
