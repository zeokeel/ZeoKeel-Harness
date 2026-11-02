# 企业微信 / 钉钉扫码登录（WebAdmin 配置 + 客户端扫码）

状态：已定稿（实现中）｜分支：`feat/wecom-dingtalk-qr-login`｜变更记录：
[`changes/2026-11-03-wecom-dingtalk-qr-login.json`](../../changes/2026-11-03-wecom-dingtalk-qr-login.json)

## 1. 背景与目标

现状：客户端登录页（`packages/host/enterprise/src/auth-gate.ts`）支持本地账号 / LDAP /
OIDC / OpenID；后两者是**浏览器跳转**方式，桌面端靠 `zeokeel://` 深链回跳拿 token。
管理后台只有本地账号（有意为之，不扩展）。

目标：管理员在 WebAdmin「认证配置」里填企业微信、钉钉的应用凭据并启用；员工在**桌面客户端**
输入服务端地址后，看到「企业微信扫码登录」「钉钉扫码登录」入口，客户端内直接展示二维码，
手机扫码确认后客户端自动完成登录（无需跳浏览器、无需深链）。

约束（来自仓库既有判据）：

- **管理后台不接扫码**：`Login.tsx` 保持「仅本地账户」，服务端 `AuthenticateConfiguredAdmin`
  的 local-only 边界不动。
- **不修改 `deepseek-harness/`**；客户端改动在 `packages/host/enterprise` 与
  `packages/host/gateway-client`。
- 仓库是公开仓：文档/代码里只能出现服务商**公开 API 域名**（已登记进域名白名单）与
  `example.com` 占位，不得出现任何客户/部署域名。
- 新增 Go 依赖 `github.com/skip2/go-qrcode`（纯 Go、无传递依赖），只用于把扫码 URL 渲染成
  PNG data URL（二维码在**服务端**生成，客户端不引 TS 二维码库）。

## 2. 非目标

- 不做企业微信/钉钉的通讯录（部门/组织）同步 —— 只做登录身份 provision；
- 不做手机端网页登录页 / 公众号 H5；
- 不做「扫码后自动建本地账号并分配部门」之外的额外权限映射（`GroupsPresent=false`，
  不触碰已有组归属；与 OIDC 缺省组声明同口径）；
- 不支持同时配置多个企业微信 corp / 多个钉钉应用（一套配置=一个 corp/应用）。

## 3. 配置模型（settings 键，唯一真源）

| 键 | 必填 | 说明 |
| --- | --- | --- |
| `auth.enabled` | 是 | CSV，新增合法值 `wecom`、`dingtalk`（与 local/ldap/oidc/openid 并列） |
| `wecom.corp_id` | 是 | 企业微信「企业 ID」（corpid） |
| `wecom.agent_id` | 是 | 自建应用 AgentId |
| `wecom.secret` | 是 | 自建应用 Secret（AES-GCM 加密存储，读面掩码 `***`） |
| `wecom.redirect_url` | 是 | 回调地址，必须 `https`（或回环 `http`） |
| `dingtalk.client_id` | 是 | 钉钉应用 AppKey（Client ID） |
| `dingtalk.client_secret` | 是 | 钉钉应用 AppSecret（AES-GCM 加密存储，读面掩码 `***`） |
| `dingtalk.redirect_url` | 是 | 回调地址，必须 `https`（或回环 `http`） |

- 密文与 OIDC client_secret 同一套：写入口 `encryptSettingSecret`，读面 `MaskSecret`（`***`），
  保存时 `***` = 保持现值。
- 回调 URL 由管理员在**服务商后台**登记，值必须逐字等于
  `<对外服务端地址>/api/client/v2/auth/<wecom|dingtalk>/callback`；WebAdmin 页面直接展示并
  提供「复制」按钮，避免手抄错。
- `auth.mode` 不新增取值（历史兼容字段，只用于 `enabled` 缺失时推导）。
- 生效路径：保存 → 单事务落库 + 审计 → `InvalidateSettings()` → `ReloadAuth()`
  （复用现有热加载）；构建失败保留旧实例并把错误回给保存接口（既有 R24-X4-B2 契约）。

## 4. 服务端 API 契约（客户端面）

所有响应：成功 `c.JSON`；失败统一 `{"error":{"code","message"}}`（`serverauth.WriteError`）。
唯一 HTML 例外是手机浏览器落地的回调**成功页**（产品 HTML 面，同 `/portal` 一类，不含任何
脚本与外部资源）。

### 4.1 登录方式发现 `GET /api/client/v2/auth/methods`（公开）

每个 method 增加布尔字段 `qr`（缺省 false）：

```json
{"methods":[
  {"name":"local","configured":true,"browser":false,"qr":false,"hidden":false},
  {"name":"wecom","configured":true,"browser":false,"qr":true,"hidden":false},
  {"name":"dingtalk","configured":true,"browser":false,"qr":true,"hidden":false}
]}
```

`configured` 仍以运行期注册表为权威（`runtimeMethodCheck`），未注册/构建失败 = false。

### 4.2 启动扫码流程 `POST /api/client/v2/auth/{wecom|dingtalk}/qr/start`

请求体：`{}`（无字段；服务端不信任客户端传入的回调地址）。响应 200：

```json
{"flow_id":"<64 hex>","qr_png":"data:image/png;base64,<...>","expires_in":300}
```

- 404 `NOT_FOUND`：该方式未配置/已禁用；
- 429 `RATE_LIMITED`：启动预算或在途配额满；
- 500 `INTERNAL`：二维码/流程创建失败。

`qr_png` 是 **PNG** data URL（服务端渲染，320px、ECC M）。客户端只允许以
`<img src="data:image/png;base64,...">` 渲染，禁止 `innerHTML` 任何服务端返回的 SVG/HTML。

### 4.3 轮询 `GET /api/client/v2/auth/{wecom|dingtalk}/qr/poll?flow_id=<...>`

200 且 `status` ∈：

```json
{"status":"pending"}
{"status":"done","token":"...","user":{"username":"zhangsan","role":"user","source":"external","password_changeable":false},"must_change_password":false}
{"status":"failed","error":{"code":"AUTH_FAILED","message":"..."}}
{"status":"expired"}
```

- `done/failed/expired` 为**终态**：响应被消费，`flow_id` 随即失效（再轮询 404 `NOT_FOUND`）；
- token 只在**首次** `done` 响应里出现一次，绝不落日志、绝不进 URL；
- 未知/已消费 flow_id → 404 `NOT_FOUND`（不泄露是否曾经存在）；
- 轮询频率由客户端控制（2s），服务端不做业务限流（flow_id 是 256-bit 不可猜）。

### 4.4 回调 `GET /api/client/v2/auth/{wecom|dingtalk}/callback?code=&state=`

由**手机浏览器**落地（服务商后台登记的 redirect_uri）。

- 成功：校验 state → 兑换 code → provision 用户 → 状态/审计账号检查 → 签发 token →
  标记 flow `done` → 200 `text/html; charset=utf-8` 极简成功页（「登录成功，请返回客户端」，
  无脚本、无外链）；
- 失败：JSON 错误信封（400 `VALIDATION` state 缺失/不匹配；401 `AUTH_FAILED` 兑换失败/
  账号禁用/审计账号；500 `INTERNAL`），同时把 flow 标记为 `failed`（带稳定 code + 可读 message），
  让客户端轮询拿到同一结论；
- 重复回调：state 已被消费 → 400（不重复签发 token）。

### 4.5 流程状态机与不变量

```
start:  pending ──callback ok────────▶ done   ──poll(done)──▶ 删除
              └──callback fail───────▶ failed ──poll(failed)▶ 删除
              └──TTL 到期────────────▶ expired ─poll/惰性清理▶ 删除
```

- state：32 字节随机 hex，单次使用；flow_id：32 字节随机 hex，单次消费；
- 流程表：进程内存，TTL 5 分钟，容量 1000；满则**拒绝新流程**（fail-closed，不驱逐在途流程）；
- 单来源 IP 在途配额 10；启动预算 30 次/5 分钟/IP（只对真实失败记账，容量拒绝单独计数，
  与 OIDC `oidcFlowLimiter` 同口径但**独立实例**，不共享预算）；
- 回调兑换：10s 超时 + `util.SafeOutboundTransport()`（链路本地/云 metadata 拦截、重定向复检）；
- 身份/授权边界完全复用 OIDC 回调：`provisionUser`（外部身份按 `ExternalID` 绑定，不接管本地行）、
  `Status != 1` → 401、`RoleAuditor` → 401 `AUDITOR_NOT_ALLOWED`、
  `issueTokenForLogin`（含自助签发配额）；
- 审计：`login_success` detail 带 `wecom|dingtalk ip=...`；失败/限流按现有动作留痕。

### 4.6 管理端 API `GET/PUT /api/server/admin/auth`

- GET 的 `auth` 增加 `wecom:{corp_id,agent_id,secret,redirect_url}` 与
  `dingtalk:{client_id,client_secret,redirect_url}`（secret 已存则 `***`）；
- PUT 接受同名字段：secret 为 `***` 保持现值，其余值（含空串）覆盖/清空；
  redirect_url 必须是 https 或回环 http；`enabled` 合法值加入 wecom/dingtalk；
- 审计 changed 集合增加 `wecom.*` / `dingtalk.*`；保存后仍走 `ReloadAuth()`。

## 5. 服务端 Provider 细节

### 5.1 企业微信（wecom）

扫码 URL（二维码内容）：

```
https://login.work.weixin.qq.com/wwlogin/sso/login
  ?login_type=CorpApp&appid=<corp_id>&agentid=<agent_id>
  &redirect_uri=<urlencoded redirect_url>&state=<state>
```

回调兑换（全部 GET，query 传参）：

1. `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=<corp_id>&corpsecret=<secret>`
   → `{access_token, errcode, errmsg}`（errcode≠0 = 失败，错误信息不得回显 secret）；
2. `https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=<token>&code=<code>`
   → `{userid, errcode}`；`userid` 为空（非企业成员/openid）= 失败；
3. `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=<token>&userid=<userid>`
   → `{userid, name, email, ...}`（取显示名/邮箱；失败不阻塞登录，回落 userid）。

`UserInfo`：`Username=userid`、`DisplayName=name`、`Email=email`、
`ExternalID="wecom:"+corp_id+":"+userid`、`ExternalSource="wecom"`、`Source="external"`、
`GroupsPresent=false`。

### 5.2 钉钉（dingtalk）

扫码 URL：

```
https://login.dingtalk.com/oauth2/auth
  ?redirect_uri=<urlencoded redirect_url>&response_type=code
  &client_id=<client_id>&scope=openid&state=<state>&prompt=consent
```

回调兑换：

1. `POST https://api.dingtalk.com/v1.0/oauth2/userAccessToken`
   body `{"clientId","clientSecret","code","grantType":"authorization_code"}` →
   `{accessToken, expireIn, refreshToken, corpId}`；
2. `GET https://api.dingtalk.com/v1.0/contact/users/me`
   header `x-acs-dingtalk-access-token: <accessToken>` →
   `{nick, avatarUrl, mobile, openId, unionId, email, stateCode}`；`unionId` 为空 = 失败。

`UserInfo`：`Username=unionId`、`DisplayName=nick`、`Email=email`、
`ExternalID=unionId`、`ExternalSource="dingtalk"`、`Source="external"`、`GroupsPresent=false`。

### 5.3 二维码渲染

`internal/serverauth/qr.go`：`qrPNGDataURL(text string) (string, error)`——用
`github.com/skip2/go-qrcode` 生成 320px、Medium ECC 的 PNG，base64 包裹成
`data:image/png;base64,...`。单测断言前缀、PNG 魔数、长度上限；不引入图像解码依赖。

## 6. WebAdmin 交互（`server/webadmin/src/pages/Auth.tsx`）

- 「启用方式」区增加两张卡片：企业微信、钉钉（label + 说明「扫码登录（仅客户端）」）；
- Tab 增加 `企业微信扫码`、`钉钉扫码` 两页，字段与 §3 一一对应；secret 用 `SecretInput`
  （已存显示占位、支持清空）；
- 每页顶部展示**回调地址**（`location.origin + /api/client/v2/auth/<method>/callback`）+
  复制按钮 + 一句「请到服务商后台登记该回调地址，值必须逐字一致」；
- 启用开关的可用性判据 = 必填项齐全（与 `REQUIRED` 一致），未配齐时禁用并提示；
- 保存仍走 `PUT /api/server/admin/auth`，payload 新增两个对象；错误就地展示；
- 管理后台登录页**不改**（仍本地账户）。

## 7. 客户端交互（`packages/host/enterprise/src/auth-gate.ts`）

- Step2 登录方式：`/auth/methods` 里 `qr:true` 的方式渲染为二维码卡片而不是「使用浏览器登录」；
- 新增本地代理路由（宿主进程，持有性证明与既有 `/auth/login` 同口径）：
  - `POST /api/zeokeel/auth/qr/start` body `{server, method}` → 转发服务端
    `POST /api/client/v2/auth/<method>/qr/start`，**校验并透传** `flow_id` + `qr_png`
    （仅接受 `^data:image/png;base64,[A-Za-z0-9+/=]+$`，长度 ≤ 200_000，否则 502，
    防止被控服务端把 SVG/HTML 塞进登录页）；
  - `GET /api/zeokeel/auth/qr/poll?server=&method=&flow_id=` → 转发轮询；`done` 时用
    服务端返回的 user 信息构造 `Session`（与 `login()` 同形状，新增
    `loginWithToken`/`sessionFromLoginPayload` 共享实现）并 `setSession`，返回 `{status:'done'}`；
  - 页面每 2s 轮询、显示「二维码已过期，点击刷新」、切换方式/返回 Step1 时停止轮询；
  - 成功后 `location.reload()`（与浏览器 SSO 成功路径一致），失败显示可读中文/英文文案
    （新增 `LOGIN_COPY` 键，zh/en 各一份）；
- 二维码 `<img>` 的 `src` 经属性转义；页面脚本**绝不** `innerHTML` 服务端返回内容
  （既有 `esc()` 纪律）；
- 不使用 `window.open`；不写深链。

## 8. 验收

| # | 命令 | 通过判据 |
| --- | --- | --- |
| 1 | `cd server && go build ./...` | exit 0 |
| 2 | `cd server && go test ./internal/serverauth/ -run 'WeCom|DingTalk|QR' -count=1 -v` | 新增用例全绿（有 PG 时含端到端；无 PG 时 DB 用例跳过但 provider/QR 单测仍必须跑） |
| 3 | `cd server/webadmin && npx vitest run src/pages/Auth.test.tsx` | 全绿，新增断言覆盖两页字段/保存 payload/掩码 |
| 4 | `cd server && go test ./internal/router/ -count=1` | 路由/方法契约不回归 |
| 5 | `corepack yarn workspace @zeokeel/dsh-enterprise vitest run tests/auth-gate-qr-login.spec.ts` | 全绿：methods→qr 卡片、start/poll 接线、PNG 校验、成功 setSession |
| 6 | `cd server/webadmin && npm run build` | exit 0（dist 可嵌入） |
| 7 | `node scripts/check-no-real-domains.mjs` | exit 0（新增服务商域名已登记理由） |

## 9. 风险与回滚

- **安全**：扫码回调是公开未认证端点，state/flow 单次使用 + 兑换超时 + 出站护栏 +
  审计；token 只经 TLS 返回给持有 256-bit flow_id 的发起端。若发现异常，管理端关闭
  `auth.enabled` 里的 wecom/dingtalk 即整体下线（运行期热加载，无需重启）。
- **兼容**：`/auth/methods` 只**新增** `qr` 字段，旧客户端忽略；旧服务端不认新值，
  客户端按 `configured:false` 灰显。
- **回滚**：代码层回滚本分支提交即可；数据层无迁移（settings 行可保留，禁用后不读取）。
