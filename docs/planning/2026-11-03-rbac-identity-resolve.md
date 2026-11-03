# ZeoKeel 接入第三方 RBAC：外部身份解析（默认关闭）

状态：实现中（2026-11-03）｜分支：`feat/rbac-identity-resolve`｜变更记录：
[`changes/2026-11-03-rbac-identity-resolve.json`](../../changes/2026-11-03-rbac-identity-resolve.json)

## 1. 背景

RBAC 已按 T21 改造完成：

- 管理后台改本地管理员账号密码登录（不再依赖 bridge OIDC）；
- 后台可手动「通讯录同步」把企微/钉钉成员写入 `sys_user / sys_dept / sys_user_identity`；
- 新增只读身份解析接口：

```
POST /internal/v1/identity/resolve
Authorization: Bearer <IDENTITY_SERVICE_TOKEN>
{"provider":"wecom|dingtalk","provider_user_id":"","union_id":"","mobile":""}
→ 200 {"uid","name","email","mobile","status","departments"}
→ 400 invalid_request / 401 invalid_service_token / 404 identity_not_found
  / 409 identity_ambiguous / 503 identity_store_unavailable
```

ZeoKeel 侧目标：员工用已有的客户端内企微/钉钉扫码登录；扫码换到 provider 身份后，由
**ZeoKeel 服务端**调用 RBAC resolve，取 `uid/status/departments`，以 RBAC uid 建档登录。
不启用时行为与现在完全一致；RBAC 查不到/停用的用户一律拒绝登录（fail-closed）。

## 2. 配置（settings，默认关闭）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `identity.external.enabled` | `false` | 总开关；关闭时零行为变化 |
| `identity.external.endpoint` | 空 | 完整 URL（如 `https://rbac.example.com/internal/v1/identity/resolve`），https 或回环 http |
| `identity.external.token` | 空 | 服务令牌，AES-GCM 加密存储；读面 `***`；写回 `***` = 保持 |
| `identity.external.methods` | `wecom,dingtalk` | 生效登录方式（当前仅这两项） |
| `identity.external.timeout_ms` | `3000` | 200–10000 |
| `identity.external.sync_groups` | `true` | 用 RBAC `departments` 全量替换 ZeoKeel 组 |

管理端 `GET /api/server/admin/auth` 增加 `identity` 对象（含 `rbac_user_count`），
`PUT` 接受可选 `identity`（缺省 = 不改）。关闭保护：已有 `external_source='rbac'` 用户时，
关闭必须带 `identity.confirm_disable=true`，否则 409 `IDENTITY_USERS_EXIST`。

## 3. 登录时序

```
客户端二维码 → 手机回调 → 服务端换 code 得 provider 身份
  → [identity.external.enabled 且 method 命中] POST RBAC resolve
      provider_user_id=企微 userid / union_id=钉钉 unionId / mobile
  → status!=1 → 拒绝
  → Username=uid、ExternalID="rbac:"+uid、ExternalSource="rbac"
    DisplayName/Email（RBAC 非空才覆盖）
    sync_groups=true → Groups=departments、GroupsPresent=true
  → provisionUser（按 uid 查/建用户，组同步）
  → 签发 token、流程 done
```

失败映射（客户端 poll 的 `failed.error`）：

| 场景 | HTTP | code |
| --- | --- | --- |
| RBAC 404 | 403 | `IDENTITY_NOT_BOUND` |
| RBAC status=0 | 403 | `IDENTITY_DISABLED` |
| RBAC 409 | 403 | `IDENTITY_AMBIGUOUS` |
| RBAC 401/400/405/5xx/超时/坏响应 | 502 | `IDENTITY_PROVIDER_UNAVAILABLE` |
| uid 与本地账号冲突 | 403 | `IDENTITY_CONFLICT` |

审计复用 `login_fail`，detail 带原因与 `ip=`，不含 mobile/token/响应内容。

## 4. WebAdmin

认证配置新增「外部权限源」Tab：启用、endpoint、服务令牌（SecretField）、适用方式
（企微/钉钉）、超时、同步部门为组、关闭保护确认、测试解析面板。保存走现有
`PUT /api/server/admin/auth`，`identity` 作为可选对象；token `***` 保持语义。

## 5. 客户端

现有二维码卡片/轮询逻辑不变；仅把 RBAC 失败原因本地化：

- 宿主 `qr/poll` 的 failed 分支同时透传白名单 `code`；
- 页面按 `IDENTITY_*` 映射 zh/en 文案，未知 code 回落服务端 message。

## 6. 非目标

- 不做客户端直推 RBAC（客户端不可信；服务端拉取等价且安全）。
- 不做 ZeoKeel → RBAC 写用户/写权限；RBAC 的用户数据来自 syncd。
- 不改 RBAC 后台登录/同步/MCP 链路。
- 不做缓存（登录频率低，避免状态/权限滞后）。

## 7. 验收

1. `cd server && go build ./... && go test ./internal/serverauth/ -run 'Identity|QR|AuthConfig' -count=1` 全绿。
2. `cd server && go test ./internal/... ./cmd/... -count=1 -p 4` 0 FAIL。
3. `cd server/webadmin && npx vitest run && npm run build` 全绿 + exit 0。
4. `corepack yarn workspace @zeokeel/dsh-enterprise vitest run tests/auth-gate-qr-login.spec.ts` 全绿。
5. `node scripts/check-no-real-domains.mjs` 零命中（仓库只用 `rbac.example.com`）。
6. 人工联调：RBAC 后台同步成员并授权 → ZeoKeel 扫码登录 → webadmin 用户名为 RBAC uid；
   停用用户后被拒。

## 8. 风险 / 假设

- ZeoKeel 存量扫码用户切换 identity 后 `external_id` 变化：启用前已建号的部署需一次性
  rebind（文档 SQL，不自动执行）；新客户建议先启用再导入员工。
- RBAC resolve 不可用时登录 fail-closed；本地超管仍可从管理后台本地登录。
- 真实企微/钉钉与 RBAC 联调需客户部署凭据；本机用 fake provider + fake RBAC 覆盖。
- 公开仓域名卫生：真实域名只进运行时配置。
