# 已上架技能的新版本发布语义（2026-10-23）

- 状态：**已实施**
- 背景：能力中心「已上架技能无法更新」——技能只要在服务端存在（不论 `apps.channel`
  是 `market` 还是 `org`、不论归属谁），作者就再也发不出新版本。
- 生产证据：10 个组织共享技能全部只有 1 个版本（`app_releases` 实测）。

## 1. 缺陷与根因（三层，缺一不可）

| 层 | 位置 | 修前 | 后果 |
| --- | --- | --- | --- |
| 服务端发布内核 | `internal/appstore/publish.go` `Publish()` | `existingApp.Channel != req.Channel` ⇒ 409 `NAME_TAKEN`；员工上传端点恒传 `Channel: org` | 归属人永远发不进 `market` 技能；`org` 技能也只能靠"首次上传" |
| 客户端 | `CapabilityCenterPanel.tsx` 的 `planCardAction` / `mergeItems` | 「上传/重新上传」只在 `source === 'local'` 命中，而归并权威序是 market > org > 本机 | 技能一上架、卡片变成商店行 ⇒ 上传入口消失（`upload()` 的 `isOwner` 预检成为死代码） |
| 管理端 | `Marketplace.tsx` 的 `ORG_LIMITS`、`Capabilities.tsx`、`internal/router` | org 行禁用「上传新版」且服务端没有该端点；审批队列只读 `ListSharedSkills`（org 渠道） | org 技能连管理员都传不了；即使造出 market pending 也无人可审 |

## 2. 定案语义

### 2.1 发布内核：渠道以 App 现值为准（`""` = 自动）

`PublishRequest.Channel` 新增合法取值**空串 = 自动解析**：

- App **已存在** + 请求渠道为空 ⇒ 渠道 = `apps.channel`（作者更新的是他自己那条内容，
  渠道不是他该重新声明的事实）；
- App **已存在** + 请求渠道非空且不一致 ⇒ **保留** 409 `NAME_TAKEN`（市场命名空间不得
  写 org 行、反之亦然；显式渠道是调用方对命名空间的声明，现有跨渠道回归用例钉住这条）；
- App **不存在** + 请求渠道为空 ⇒ `org`（员工上传的默认落点）；
- App **不存在** + 请求渠道非空 ⇒ 用请求渠道。

解析结果只用于落库，**后续全部判据不变**：归属保护（`AppOwnedBy`）、官方锁
（`OFFICIAL_LOCKED`）、能力锁（`APP_LOCKED`）、待审配额（`PENDING_LIMIT`）、
版本递增/版本已存在/内容未变、changelog 必填、下架冻结（`APP_DELISTED`）、
待审版本的展示投影冻结。`AdminPublish=true`（管理端）语义不变：发布即 `approved`。

### 2.2 员工上传：任意渠道、只认归属

`sharedskills.Upload` / `agentshare.Upload` 不再硬编码 `Channel: org`，改为传空串交给内核
解析。于是：

- 归属人给已上架的 `org` 技能发 v2 ⇒ 201 `pending`；
- 归属人给已上架的 `market` 技能发 v2 ⇒ 201 `pending`（**新契约**）；
- 非归属人 ⇒ 409 `NAME_TAKEN`；官方行非管理员 ⇒ 403 `OFFICIAL_LOCKED`；
- 非管理员发布**一律 pending**（含 `market` 行，不允许员工直发）。

### 2.3 市场语义（新契约，务必记入产品口径）

**`market` = 管理端直发 + 归属人可提交待审。**

- 管理端在市场命名空间上传 ⇒ `approved`（与旧行为一致）；
- 归属人从客户端提交 ⇒ 落 `pending`，由管理员在审批队列通过后生效；
- 审批人始终是管理员（能力中心 `capability:write`），员工不能绕过审核让自己生效。

### 2.4 作者面：渠道无关

`serverstore.ListOwnedSharedSkills` / `ListOwnedAgentPresets` 从「只看 `channel='org'`」
改为「`apps.owner == viewer` 的**任意渠道**，忽略上下架」，DTO 增加 `Channel string`
投影。`capabilities.listCapabilities` 的「我的」分区因此不再需要市场专用取数块
（R6-D P2-2 的那两块），`appendSharedSkill` / `appendSharedAgent` 的 `Source` 按行渠道
下发（`market` / `org`），否则市场待审行会被客户端显示成组织行。

分发面口径**完全不变**：`ListVisibleSharedSkills` / `ListSharedSkills` / 员工面
`sharedskills.listVisible` / 客户端 `?source=market|org` 仍然只服务各自的渠道与
`approved ∧ delivered`。

### 2.5 审批面：市场待审行进入统一队列

`capabilities.listApprovals` 增加 **market 渠道的 pending 行**
（`ListReleasesByStatus` + 渠道过滤，只在 `pending` / `all` tab 出现；market 的
`approved` / `rejected` 历史仍归市场页）。行上新增 `channel` 字段，`base_path` 指向
**市场命名空间**：

- 技能：`/api/server/admin/skills/:name/:version/{approve,reject,preview,archive,file}`
- 智能体：`/api/server/admin/agents/:name/:version/{approve,reject,preview,archive,file}`

审核落定的唯一实现被抽到 `serverstore.ReviewPending`（状态落定 + 下架冻结 + 投影重算），
组织库与市场两个审核入口共用同一份语义。

### 2.6 管理端

- 组织共享行放开「上传新版」：`POST /api/server/admin/shared-skills/:name/archive` 与
  `POST /api/server/admin/agent-presets/:name/archive`（管理员代传，`AdminPublish` ⇒ 已审核）；
- 市场技能行**下架态**时「上传新版」禁用并给出原因（先重新上架），不再只在点击后吃 409；
- 审批队列渲染 market 待审行（来源列 + 只展示有端点的动作：通过/拒绝/预览/归档/转移）。

### 2.7 客户端

`planCardAction` 的商店行增加一档：**归属人 + 本机已安装 + 非官方 + 未下架 ⇒
`{ kind: 'upload' }`**（复用既有 `upload()`，无需新端点；`market` 行追加
「新版本需管理员审核后生效」提示）。`mergeItems` 的权威序**不动**（被回归用例钉死）。

## 3. 保留的硬不变量

- **版本号永久占位**：被拒/软删的版本号不可复用（红线；不要再走"删行释放名字"的人工清库）。
- **下架冻结**（R5-B-1）：下架期间上传与审批通过一律 409 `APP_DELISTED`，出口是管理员
  显式重新上架（带审计）。
- **归属为空不可传**：官方内容与 2026-09-02 之前的历史行（`owner=''`）不属于任何人，
  非管理员一律不能接管。
- **待审不改投影**：`apps.title/description` 只在 `approved` 落定时重算。
- **渠道边界**：显式渠道与既有 App 不一致仍 409；市场命名空间不服务 org 行、反之亦然。

## 4. 数据与兼容

- **无数据库迁移**：渠道仍是 `apps.channel`，只是写面放行条件变了；`ApprovalRow.channel`
  是响应字段（旧客户端忽略）。
- **旧客户端不受影响**：没有新入口就还是老行为；旧服务端不认空渠道 ⇒ 新客户端连旧服务端
  仍然只走 `org`（上传入口在旧服务端仍表现为 409，属已存在的旧缺陷）。
- **发布顺序**：服务端 + 管理端先上线 → 客户端随后（服务端先放行不会产生任何新入口）。

## 5. 风险与取舍

1. **市场语义变化**：员工可以提交 `market` 技能的新版本（待审），审批人变成管理员。
   这是新契约，见 §2.3。
2. **归属人卡片不再有「卸载」**：页脚只有一个动作格，`isOwner && installed` 现在出
   「上传新版」。删掉本机那一份仍可通过其它入口（本机未安装时是「安装」，非归属人仍
   是「卸载/更新」）；这是为换取"作者始终能发新版"接受的取舍。
3. **待审徽章的一个已知限制**：技能已有 `approved` 版本时，`capabilities` 的
   `mergeVersions` 会把展示行钉在 `approved` 上，`pending` 的 v2 不会单独成为展示行
   ⇒ 卡片徽章仍显示「已通过」，而不是「等待审核」。作者侧的可达动作不受影响（上传入口
   由 `isOwner + installed` 决定），且 `marketReviewHint` 明确提示"需审核后生效"。
   若后续要求"待审徽章必须出现"，需给 `CapabilityItem` 增加独立字段（如
   `pending_version`），不要改 `mergeVersions` 的展示行选择（会让客户端把待审版本当成
   可安装版本）。
4. **市场渠道的版本级管理动作**（删除/质量/上下架/授权）不在审批队列里开放：
   市场命名空间没有这些版本级端点，强行渲染只会 404；这些动作仍在市场页。

## 6. 判据

服务端：

- 归属人给已上架 `market` / `org` 技能发 v2 ⇒ 201 `pending`（渠道不变、投影不变、分发面
  仍只见旧 `approved` 版本）；非归属人 ⇒ 409 `NAME_TAKEN`；
- 官方行 / 被锁能力 / 配额满 / 下架中 ⇒ 各自原码；版本不递增 / 版本已存在 / 内容未变 ⇒ 409；
- 管理员 approve 后：投影（`apps.title/description`）重算、员工可见、下载 200；reject 后
  归档释放且版本号仍占位；
- 审计：`shared_skill_upload` / `agent_preset_upload` / `market_skill_approve|reject` /
  `market_agent_approve|reject` 各有行；
- 管理员上传 org 新版本 200（`AdminPublish` 语义），非管理员 403（RBAC）。

管理端接口：

- `/admin/capabilities/approvals` 含 market pending 且 `base_path` 指向市场命名空间；
  `approve` / `reject` 需要 `capability:write`；
- 审批队列对 market 行不下发无端点的动作。

客户端纯函数（`capability-center-panel.spec.ts`）：

- 商店行 + `isOwner:true` + `installed` ⇒ `{kind:'upload'}`（两种到达顺序都成立）；
- `isOwner:false` / `delisted:true` / `official:true` ⇒ 无上传。

端到端（真机 + 真服务端，发布后验收）：

- 归属人在客户端更新一个已上架技能 → 管理端审批 → 其他员工看到「更新到 vX」并可装；
- 反向：非归属人上传同一名字被 409 挡住。
