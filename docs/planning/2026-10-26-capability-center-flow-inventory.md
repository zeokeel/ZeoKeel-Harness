# 能力中心（技能 / 智能体）全流程盘点

- 日期：2026-10-26
- 基线：`80c48abca3`（master）
- 方法：4 个只读审计泳道（服务端 / 客户端 / 管理端 / 文档-测试），逐文件读 + 逐用例核对；本文为汇总，证据行号以代码为准。
- 结论速览：**实体被压扁、动作矩阵缺失、术语混用**；功能面齐全但三端各自推断状态，导致「流程乱 → 界面乱」。
- 严重度：P0×1（管理员可达的数据丢失）、P1×11、P2×26、P3×17；无未授权直达的 P0。
- **实施状态（2026-10-26 晚追加）**：本文证据行号以 `80c48abca3` 审计基线为准；客户端能力中心重构、客户端 F-07~F-11/F-29、管理端 D-01~D-16 已落地（客户端/管理端见提交 `7555b23c3a` 与 P3 收口提交）。**P0/F-02~F-06/F-12~F-55 仍只是盘点结论，不是已修** —— 不要把本文当成"全部已关闭"的清单。落地/未落地对照见 §13。

---

## 1. 实体与数据模型（唯一真源）

| 实体 | 真源 | 关键字段 | 说明 |
|---|---|---|---|
| App（目录身份） | `apps`（`0053_apps.sql:17`） | PK `(kind, app_id)`；`channel market\|org`；`owner`；`enabled`(上下架)；`official`(`0059`) | `owner` 是**发布权唯一源**；`enabled=0` 即下架（可逆） |
| Release（版本） | `app_releases`（`0053:30`） | `UNIQUE(kind,app_id,version)`；`status pending\|approved\|rejected`（另有 `withdrawn`，WASM 用）；`deleted_at` 软删；`archive BYTEA`；`quality` | 版本号**永久占位**；`deleted_at` 后 archive 清空、不可复用 |
| Grant | `app_grants`（`0053:59`） | `(kind,app_id,grantee_type,grantee)` | 两渠道共表；授权按 name 生效 |
| Lock | `capability_locks`（`0050`） | `(kind,name)` | 可对**尚不存在**的名字预锁定 |
| Review（审批） | **无表**，`release.status` 派生（`capabilities.go:725`） | — | 审批历史只存在于审计日志，不在可查询表 |
| Installation | **服务端不存**（`capabilities.go:42`） | — | 只在客户端磁盘（`.zeokeel/release.json` 等） |

**没有的字段/实体**：独立的「动作/审批任务」「上架历史」「下架原因」「待审版本投影」。这正是后面所有不一致的结构性来源。

---

## 2. 状态模型（实际实现）

### 2.1 目录（App）

```
enabled=1（上架） ⇄ enabled=0（下架）
   ├─ 下架冻结：上传 / 审核通过 / 管理员直发 一律 409 APP_DELISTED
   ├─ 唯一出口：管理员重新上架（有审计）
   └─ 删除 App：不存在（DELETE 只置 enabled=0；全仓无 DELETE FROM apps）
```

### 2.2 版本（Release）

```
(无) --员工上传--> pending --approve--> approved
(无) --管理员直发/管理员代传/规范化--> approved
pending --reject(理由<=500, 清 archive)--> rejected
approved --reject--> 409 APPROVED_NOT_REJECTABLE
rejected --approve--> 409 ARCHIVE_CLEARED
任意 --DELETE 版本--> deleted_at 置位 + archive=NULL（版本号永久占位）
```

### 2.3 安装（客户端）

```
未安装 --install--> 已安装(v) --update--> 已安装(v') --uninstall--> 未安装
覆盖(overwrite=1)：同端点重装，可换渠道；符号链接/内置/插件走不同端点
```

**服务端不知道安装状态**，`installed` 由客户端从磁盘推断（`CapabilityCenterPanel.tsx:1010`）。

---

## 3. 面清单

### 3.1 客户端（能力中心整页）

| 面 | 内容 | 数据源 |
|---|---|---|
| 四分段：全部 / 已安装 / 我上传 / 市场（**2026-10-26 实施后**；审计基线只有我的/市场） | 三个来源的并集 + 段内过滤 | `?source=market` / `?source=local` / `?source=own` |
| 平台内置入口卡 | 内置技能的「安装/更新/卸载」 | `/api/zeokeel/skills/builtin` |
| 卡片 | 展示名主标题 + slug 副标 + 最多 2 Chip + 两行描述 + 版本·作者 + 一个主动作 +「详情」 | 归并行 |
| 详情子视图 | 版本列表、描述、changelog、状态说明、动作（**由弹层改为面板内整页**） | 归并行 |
| 确认条/结果条 | 覆盖确认、上传结果、卸载确认 | 动作状态 |

### 3.2 管理端（`/capabilities` 四 Tab）

| Tab | 页面 | 内容 |
|---|---|---|
| 技能 | `Marketplace.tsx` | 市场列表 + 组织「已通过」行合并；动作：预览/规范化/编辑/上传新版/归属/授权/下架|重新上架/上架技能 |
| 智能体 | `Agents.tsx` | 同构（无规范化） |
| 审批 | `Capabilities.tsx` | 待审核/已通过/已拒绝/全部 + 类型筛选；动作：预览/下载/转移/授权/上架|下架/通过/拒绝/删除 |
| 平台内置 | `BuiltinSkills.tsx` | 只读诊断（dir/counts/problems/skills） |

---

## 4. 端点清单（按面）

### 4.1 员工面（Bearer）

| 组 | 端点 | 说明 |
|---|---|---|
| capabilities | `GET /client/v2/capabilities?source=market\|org\|own\|local` | 三源归并；own 含下架/任意状态；依赖故障 500 |
| marketplace | `GET /marketplace/skills`、`/skills/:name`、`/skills/:name/archive` | 市场技能（授权制；下架/未授权同 404） |
| builtin | `GET /skills/builtin`、`/skills/builtin/:name/archive` | 镜像资产，无审批/owner 语义 |
| shared-skills | `GET/POST /shared-skills`、`GET /:name/:version/archive` | 201 pending、配额 10；下载=approved∧上架∧(授权∨归属) |
| agent-presets | `GET/POST /agent-presets`、`GET /:name[/:version]/archive` | 同上；**两渠道都服务** |

### 4.2 管理面（AdminAuth + RBAC）

| 组 | 端点（代表性） | 权限 |
|---|---|---|
| 市场技能/智能体 | `GET/POST /skills`、`POST /:name/archive`、`PUT /:name`、`DELETE /:name`(下架)、`POST /:name/enable`、`GET /:name/{preview,file,archive}`、`POST /skills/:name/normalize`、grants×4、版本级 approve/reject/preview/archive/file | market:read/write；版本审校 capability:read/write |
| 组织共享技能 | `GET /shared-skills`、`POST /:name/archive`、`GET /:name/:version/{archive,preview,file}`、`POST {approve,reject}`、`DELETE /:name/:version`、`PUT /:name/:version/quality`、`PUT /:name/enabled`、grants×4 | capability:read/write |
| 组织智能体 | 逐条镜像；另有**遗留 name 级** approve/reject/delete | capability |
| 审批/内置/归属 | `GET /capabilities/approvals?status&type`、`GET /skills/builtin`、`PUT /apps/:kind/:app_id/owner` | capability |

---

## 5. 动作矩阵

### 5.1 客户端 `planCardAction`（审计基线 `CapabilityCenterPanel.tsx:633-707`；实施后为 `planCardActionForTab`）

| source | 条件（按分支顺序） | 输出 | 备注 |
|---|---|---|---|
| local | originChannel=builtin/plugin | uninstall | |
| local | `isOwner=false` 且有 `uploadStatus` | transferred | **无数据源，死分支** |
| local | `isDelistedItem` | uninstall | 第三条推断路径 |
| local | `originSymlink` | linked | |
| local | uploadStatus=rejected/pending/approved | reupload / review(pending) / review(approved) | review(approved) **互斥不可达** |
| local | 其余 | upload | |
| market/org | delisted 且 installed | uninstall | |
| market/org | delisted 且未装 | delisted | **生产不可达** |
| market/org | 未装（含 owner） | install | |
| market/org | 已装 + isOwner + 非 official | upload | |
| market/org | 已装 + hasUpdate | update | official 时禁用 |
| market/org | 已装其余 | uninstall | |

输入维度：`source`、`installed`、`isOwner`、`official`、`delisted`、`enabled`、`status/uploadStatus`、`localOwnership`、`installedOrigin`、`originChannel`、`originSymlink`、`hasUpdate` → 组合爆炸，且**这是纯客户端推断**。

### 5.2 管理端动作矩阵（核心动作；完整端点见 §4）

| 动作 | market 行 | org 待审 | org 已通过 | org 已拒绝 | 端点 |
|---|---|---|---|---|---|
| 预览/下载 | ✔ | ✔ | ✔ | ✔（必失败） | preview/archive |
| 通过/拒绝 | ✔ | ✔（下架时禁用） | ✘ | ✘ | approve/reject |
| 删除 | ✘ | ✔ | **✔（无守卫）** | ✔ | DELETE 版本 |
| 质量 | ✘ | — | ✔ | — | 仅 org |
| 授权 | ✘ | — | ✔ | — | grants |
| 上架/下架 | 市场页 | — | ✔ | — | DELETE/enable 或 shared enabled |
| 上传新版 | 市场页 | — | — | — | /:name/archive |
| 批量/分页 | ✘ | ✘ | ✘ | ✘ | — |

### 5.3 三端同一动作对照（详见审计原文）

| 动作 | 客户端 | 管理端 | 服务端 |
|---|---|---|---|
| 创建/发布 | 无 | 市场「上架」两步（先建行后传包） | `Publish`（Admin→approved） |
| 上传新版 | 客户端「上传新版」（仅 owner+已装+非官方+未下架） | market 填版本直发；org 代传即 approved | channel 空串沿用 apps；非 Admin→pending |
| 审批 | 只看状态 | 通过/拒绝（capability:write） | approve/reject（下架冻结） |
| 上下架 | 无动作，只有徽标/提示 | 技能/智能体页 + 审批页(org) | DELETE /skills/:name、PUT enabled |
| 删除 | 仅卸载本机 | 审批页删除 org 版本（无守卫） | 软删+清 archive，无状态校验 |
| 授权/归属 | 不可见 | GrantDialog/归属 | grants、PUT owner |

---

## 6. 不变量与现有判据

| 不变量 | 来源 | 判据 |
|---|---|---|
| 版本号永久占位（含 rejected/软删） | `2026-09-01-skill-app-management.md:108`、`2026-10-23:92` | `publish.go` + 测试 |
| 版本严格递增 / 同内容拒绝 | D0901 | `publish_test`、`publish_r25` |
| changelog 非首版必填 | D0901:151 | `publish.go` |
| 下架冻结（上传/审批/直发 409） | `2026-10-23:93` | `r5b_delist_owner_semantics` 等 |
| 待审不改投影 | `2026-10-23:97` | `TestPendingReleaseDoesNotPolluteProjection` |
| 渠道边界（显式不一致 409；空串自动） | `2026-10-23:98` | `publish_r25_channel_auto` |
| 归属保护（`apps.owner` 唯一；空 owner 视同占名） | `2026-09-02` | `publish_test`、`bn3` |
| 官方锁（official 仅管理员发版） | `2026-09-04` | `admin_test` |
| 能力锁可预占 | D0901:244 | `TestCapabilityLock` |
| 待审配额 10（publisher 维度、跨 kind） | D0901:205 | `publish_test` |
| 审核原子 / 拒绝即释放 | 审计 R4 | `routes_n4_review_race` |

**缺口**：这些不变量只在服务端测试里；客户端与 UI 没有对应的动作矩阵判据（`planCardAction`/`mergeItems` 的用例实际寄居在 `packages/host/enterprise/tests/`）。

---

## 7. 术语表（混用是乱的直接来源）

| 词 | 代码/端点实际含义 | 冲突 |
|---|---|---|
| 上传 / 上传新版 | 打包本机目录→网关建共享或发新版（`shared-skills|agent-presets/upload`） | 与「发布/上架/共享」混用 |
| 发布 | 服务端 `appstore.Publish` 写入版本 | 客户端无此词 |
| 上架 / 下架 | `apps.enabled=1/0`；下架冻结上传/审核 | 客户端无字段、无动作，只有状态 |
| 审核 / 已共享 | pending→approve/reject；approved 又称「已共享」 | 与「已安装」并列易混 |
| 安装 / 更新 / 覆盖 | 下载归档解包；更新=重装高版本；覆盖=overwrite=1 可换渠道 | 「更新」对官方恒禁用 |
| 卸载 | 只删本机目录，不等于撤回发布 | 与「删除/下架」混用；「仍要删除」复用覆盖语义 |
| 归档 | 服务端 zip（archive 端点）；provenance 的 `archiveChecksum` 实为内容树哈希 | 同词两义 |
| 转交 | `apps.owner` 归属转移 | 客户端只是状态且几乎不可达 |

---

## 8. 问题总表（全部）

### P0

| ID | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| F-01 | **已通过版本可被「删除」永久清空归档且不重算投影**：审批页对所有 org 行给删除；服务端 `remove` 无状态守卫，`SoftDeleteRelease` 直接 `archive=NULL`，不调 `RecomputeAppProjection` | `Capabilities.tsx:510-512`、`sharedskills/routes.go:614-645`、`apps.go:742-753` | 在服版本归档不可恢复；投影仍指向旧标题；与「已通过不可拒绝」语义矛盾（拒绝 409、删除 200） | 禁止删 approved（或 409 + 先下架）；删除后强制重算投影；补回归用例 |

### P1

| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| F-02 | 注册即永久占名：管理员「新建」只 `UpsertApp`，失败/放弃后无 release、无删除 App 路径；跨渠道互斥 ⇒ 打错名永久占两渠道 | `marketplace/admin.go:241`、`agent_api.go:70`、`serverstore/skills.go:128` | 只能改库；卡片「尚未发布版本」但预览 404 |
| F-03 | `normalize` 绕过统一发布内核：`ReplaceSkillArchive` 直接 `CreateRelease(approved)`，不判递增/changelog/官方锁/能力锁/下架冻结 | `marketplace/admin.go:634-760`、`serverstore/skills.go:201` | 规范化 = 后门发布；可绕过下架冻结 |
| F-04 | 展示版本两口径：投影按 `id DESC`，交付按 semver 最大 | `serverstore/apps.go:182` vs `skills.go:54` | 目录标题/描述与可下载版本可能分叉 |
| F-05 | 权限反转：`market:write` 可 `POST /:name/archive` 直发 approved，而批准员工待审版要 `capability:write` | `router/optional_skills_on.go:152,213`、`publish.go:335` | 拆分运营/审核角色后直发即绕审核门 |
| F-06 | 组织多版本在管理端技能/智能体页变成多张同名卡（每版本一行、key=name、不去重） | `shared_skills.go:104-141`、`Marketplace.tsx:167-191`、`Agents.tsx:132-145` | 预览/上传指向旧版；卡片误点 |
| F-07 | 客户端卸载后卡片不消失/状态回弹：只改 `installed`，`installed` 又由存在 local 行推导，且不重载 | `CapabilityCenterPanel.tsx:1561,1010,1545-1566` | 二次操作必失败；30s 后卡片翻「上传新版」但磁盘已空 |
| F-08 | 待审/被拒不可见：客户端只请求 `source=market\|local`，own 仅用于匹配；无本机副本的 pending/rejected 任何面都看不到；已 approved 时 pending 徽章被压制 | `P:1386-1395`、`R:1201-1290`、`D1023:115-121` | 作者无法确认排队/拒因；「已上架技能无法更新」的体验残留 |
| F-09 | 官方内容「更新」死按钮：`planCardAction` 给 update，渲染层因 `official` 永久禁用，且该卡无卸载；文案称「仅管理员可更新」但详情同版本可装 | `P:698-701,1848`、`locales.ts` | 已装官方旧版永远无法升级，用户被困 |
| F-10 | 409 一律当「覆盖确认」：不读 code，非 `LOCAL_CONTENT` 的 409 进确认死循环；回退条 reason 默认 local 文案错 | `P:1452-1459` | 用户反复确认仍失败；误导为「本机自制」 |
| F-11 | 审核结果粘滞：只轮询 market，本机行 status 不刷新；归并又优先 pending | `P:1420-1435,991-992` | 通过后仍显示「审核中」直到重挂载/安装/上传 |
| F-12 | 新契约缺跨层验收：只有服务端集成 + 包内单测，没有「客户端上传→管理端审批→他人更新」E2E | D1023:149-152、测试矩阵缺口 | 三端语义漂移不可见 |

### P2

| ID | 问题 | 证据 |
|---|---|---|
| F-13 | `ReviewPending` 号称三面唯一实现，实际仅市场调用；org 两处仍手写 | `review_pending.go:20`、`review.go:142`、`sharedskills:548-609`、`agentshare:601-626` |
| F-14 | 下架冻结是 check-then-act：先读 Distribution，更新 `WHERE` 无 `enabled` ⇒ 并发可出 approved + 下架行 | `review_pending.go:50`、`apps.go:674` |
| F-15 | 归属转移不参与发布锁：`Publish` 锁内读 owner，并发可让旧归属人替新归属人提交 | `admin.go:45`、`publish.go` |
| F-16 | 存在性泄漏：approve 先 `SkillNameExists` 回 409 CONFLICT（仅 market 行触发），同端 reject 回 404 | `sharedskills:519` |
| F-17 | `@` 前缀处理不一致：PUT grants 不剥（`@研发部`→400），agent_api 剥 | `grants.go:236`、`agent_api.go:470,552` |
| F-18 | `app_grants` 缺 `(grantee_type,grantee)` 索引；热路径 `AccessibleAppIDs` | `0053:59`、`apps.go:803` |
| F-19 | 市场版本历史客户端不可达：只投影展示版，员工面仅 name 级 archive | `capabilities.go:153`、`skill_api.go:33` |
| F-20 | `author` 二义：org=release.publisher，market=apps.owner | `shared_skills.go:78`、`skills.go:79` |
| F-21 | 删除文案失真：名称/版本永久占用，市场冲突提示「请先在共享库处理」但无解除入口 | `apps.go:742`、`marketplace/admin.go:267` |
| F-22 | 已拒绝行仍给预览/下载：拒绝即清 archive ⇒ 预览 404 / 下载 500 | `Capabilities.tsx:452-459`、`sharedskills:862-995` |
| F-23 | Tab 计数不随动作刷新：计数只依赖 typeFilter，动作后只刷 allRows | `Capabilities.tsx:208-216,241` |
| F-24 | 「全部」名不副实：market 只并 pending；market 已通过/已拒绝与拒因在管理端无列表 | `capabilities.go:977-979` |
| F-25 | market 精选无入口/端点：注释称在市场页，实际无 quality 动作；服务端仅 org 有 quality | `Capabilities.tsx:426-428`、`sharedskills:713` |
| F-26 | 无批量、无分页：审批逐条，列表全量 | `Capabilities.tsx:451-513`、`capabilities.go:775-970` |
| F-27 | 归属冲突码文档三种写法（404/409 混用） | `P0902:44,90,132`、`P0904:52` vs `publish.go:273` |
| F-28 | 死分支无生产数据：`enabled:false` 无服务端下发、`transferred` 无数据源、`review(approved)`/`delisted-store` 不可达 | `P:584,601-603,1054` |
| F-29 | `is_owner` 缺失读成 false：旧服务端/裁剪载荷下作者失去上传入口，且预检报「名称已占用」 | `R:1394,1425`、`P:1577-1585` |
| F-30 | 智能体渠道恒 org：市场智能体在「我的」显示「组织」，来源/下架文案错位 | `R:865,1094`、`A:355` |
| F-31 | 撤权/跨账号内容给「上传」：明知无副作用仍出按钮，点击必 NAME_TAKEN | `P:650-654`、`capability-local-ownership.spec.ts:206` |
| F-32 | 上传无版本输入：版本只取 SKILL.md；未改版本再传→服务端英文错误直出 | `I:3894-3902` |
| F-33 | 归并版本混入草稿：local 行 version 可为未发布版本，却计入 approved 集 | `P:983`、`R:1278` |
| F-34 | 符号链接商店行仍给上传：`linked` 只在 local 分支，归并为 market/org 的 owner 仍出「上传新版」 | `P:664` vs `:698`、`I:3978` |
| F-35 | 内置更新吞同名卡：按 name 跨源去重，本机卡（唯一卸载入口）被吞；未装内置卡也吞同名市场行 | `P:826-836`、`B:366` |
| F-36 | dirty 排除清单未落地：仅剔 `.zeokeel/` + 平台字段，缓存文件误判→覆盖确认噪音 | `D0901:415`、`skill-install.ts:3703-3726` |
| F-37 | 30s 轮询可回退刚完成的安装态：仅 seq 守卫，无时序判据；连续两轮认账未修 | `v2.8.0:82`、`AUDIT-2026-09-23-FULL.md:1495` |
| F-38 | 动作逻辑无本包判据：`planCardAction`/`mergeItems` 用例寄居 `packages/host/enterprise/tests/`，本包仅 3 个 spec | D1023:144、包内 tests/ |

### P3（合并行见 F-54/F-55；逐条明细见 §13.4，不是遗漏）

| ID | 问题 | 证据 |
|---|---|---|
| F-39 | `quality` 无 DB CHECK，`SetReleaseQuality` 不校验 | `0053:47`、`apps.go:728` |
| F-40 | `review.go:407` 未 `NormalizePath`、空 path 不 400、解析错 500（技能侧 422） | `review.go:407` |
| F-41 | agentshare 校验被忽略的 `req.Version`（sharedskills 不校验） | `agentshare:441`、`sharedskills:337` |
| F-42 | 同名冲突四码：Publish 409 NAME_TAKEN / createSkillAdmin 400 / createAgentAdmin 409 CONFLICT 或 400 | 多文件 |
| F-43 | `listApprovals` 吞错，与同文件「必须 500」相反 | `capabilities.go:359` |
| F-44 | 审核/质量/删除审计不带 `app_id` | `sharedskills:610,642`、`agentshare:627,676` |
| F-45 | 陈旧代码：`mergeMarketFirst`、`SkillNameExists` 0053 后不可命中 | `capabilities.go:646`、`skills.go:97` |
| F-46 | 60s 事务超时也映射 503 `PUBLISH_BUSY` | `publish.go:194` |
| F-47 | 常量复制：`pendingCap` 两处、16/24MiB 字面量 | `sharedskills:44`、`agentshare:28`、`admin.go:287,319` |
| F-48 | 能力中心四页零 `hasPermission`；应用中心同权限有门 | `Capabilities.tsx`、`Apps.tsx:595` |
| F-49 | 下架确认不一致：技能 confirm、智能体无、审批页无 | `Marketplace.tsx:299`、`Agents.tsx:244`、`Capabilities.tsx:474` |
| F-50 | 术语混用（客户端「审核中/已共享/未通过」vs 管理端「待审核/已通过/已拒绝」；「组织」vs「员工上传」） | `locales.ts:51-53`、`Capabilities.tsx:75-79`、`Marketplace.tsx:435` |
| F-51 | `official` 未接管理端 `ApprovalRow`；`conflict` 恒 false 仍留 UI | `capabilities.go:765,825`、`Capabilities.tsx:25-60` |
| F-52 | 遗留 name 级 agent-presets approve/reject/delete（DELETE 删全部版本），webadmin 未用 | `agentshare/routes.go:573-633,828-873` |
| F-53 | 残留「Git 源」文案（git 模式已删）；`builtin` 与 `GET /skills/builtin` 同段；内置 `source` 未渲染 | `Marketplace.tsx:511,525`、`optional_skills_on.go:134`、`skillseed.go:510` |
| F-54 | 客户端徽章/排序/搜索/字段问题：已下架/已转交重复渲染、版本 chip 仅 local、搜索口径与内置不一致、score/downloads/calls 不下发展示、弹层快照过期、无刷新入口、错误码未映射、auditor 按钮不隐藏 | `P:1663,1681,1635,1616`、`B:306`、`P:1114` |
| F-55 | 测试/文档债：核心纯函数测试寄居 enterprise；路由/发布规范/发布说明三处漂移；新契约无 release note | D 泳道 §5 |

---

## 9. 根因（为什么“流程乱 → UI 乱”）

1. **实体被压扁**：Skill/Release/Installation/Review 压成一个 `CapabilityItem`，四个生命周期用一个卡片表达 → 需要大量布尔/状态合成为动作。
2. **三处状态源**：服务端（channel/status/enabled）、客户端（`mergeItems` 权威序 + 磁盘 provenance）、管理端（`ORG_LIMITS`/队列）各自解释同一业务事实。
3. **动作矩阵从未显式定义**：每个面在自己的代码里补洞（R5-B 下架、R6-D 归属、R25 渠道、10-23 作者面），补丁叠加成 12 分支的 `planCardAction` 与 9 种死/活分支。
4. **服务端只给“状态字段”，不给“允许动作”**：客户端/管理端只能推断，推断规则一多必分叉。
5. **术语混用**：上传=发布=上架、卸载=删除=下架、归档两义 → 产品、前端、后端对同一动作理解不同。
6. **验收只到单层**：服务端有强不变量测试，客户端/管理端没有动作矩阵/三端一致判据，新契约无 E2E。

---

## 10. 建议的修复顺序（不改语义先收敛）

1. **先做动作矩阵评审**（本文 §5 即草案）：补齐空单元、删掉不可达分支、确定「官方能否更新」「删除 approved 是否允许」「待审如何展示」。
2. **服务端下发 `allowed_actions` + `disabled_reason`**：每个面只渲染服务端给的动作；审批/下架/删除/上传全部走同一状态机校验。
3. **拆投影面**：市场目录 / 我的提交 / 本机已安装 / 审批队列 / 平台内置；每面一个主动作；pending 用独立字段或独立行。
4. **统一命令与错误码**：上传、提交、通过、驳回、上架、下架、删除、安装、卸载各一个语义；同状态冲突统一 409 + 指定 code。
5. **补三端契约测试**：矩阵逐格（角色×状态×动作）+ 一条真实 E2E（上传→待审→通过→他人更新→下架→重新上架）。
6. **清理死代码/死字段**：`enabled` 客户端字段、`transferred`、`review(approved)`、`delisted-store`、遗留 name 级端点、Git 源文案。

---

## 11. 待产品/架构拍板（代码无法自证）

1. 跨渠道同名是否永久互斥（当前主键决定，且无删除 App 路径）。
2. market 是否允许归属人提交待审（2026-10-23 已允许）——与「市场=管理端直发」口径如何对外表述。
3. 管理员直发能否越过下架冻结（当前不能）/ 越过待审更高版本（当前能）。
4. 已通过版本是否允许「删除」；若允许，是否先下架、是否可恢复。
5. 待审配额是全局 10 还是分 kind/渠道（当前跨 kind）。
6. 审核通过是否自动上架（当前刻意不自动）。
7. 市场是否需要版本级下载/回滚/历史（库里有数据、接口没有）。
8. 规范化产物是否必须走审核（当前直接 approved）。

---

## 12. 显示变量专项（2026-10-26 追加）

### 12.1 直接原因（为什么管理后台显示英文目录名）

事实链（按数据流）：

1. **服务端根本不返回展示名**：市场技能的 `skillJSON`（`server/internal/marketplace/skill_api.go:247-261`）只输出 `name/version/description/author/checksum/enabled/downloads/calls/official/created_at/updated_at`，**没有 `display_name`/`title`/`quality`/`source`**；而 `serverstore.Skill.DisplayName`（`serverstore/skills.go:15-17`，来自包内 `SKILL.md` 的 `title`）已经存在，只是被投影层丢掉。
2. **管理端模型没有这个字段**：`Marketplace.tsx` 的 `Skill` 接口（`:18-55`）没有 `display_name`/`title`；卡片主标题直接写 `{s.name}`（`:425`）。
3. **组织行把字段丢在归并里**：`Marketplace.tsx:170-178` 从审批队列取到 `display_name`，但 push 进 `Skill[]` 时只映射 `name/version/description/author/...`，`display_name` 被丢弃。
4. **管理端无处可改**：`skillReq`（`marketplace/admin.go:234-239`）与 `agentReq`（`agent_api.go:63-67`）都没有 `Title`；编辑表单只有描述/作者（`Marketplace.tsx:68-75`、`:226-236`；`Agents.tsx:263-272`）。`UpdateSkillMeta` 只会把现有 `DisplayName` 写回（空则回落 `name`，`serverstore/skills.go:182-196`）。
5. **客户端已修、管理端没修**：客户端 `skill-routes.ts:1417-1421` 明确把 snake_case `display_name` 映射成 `displayName`，并注释「避免卡片标题恒等于 name」；管理端没有对应映射。

结果：只要 `SKILL.md` 里有中文 `title`，客户端显示中文、管理端技能页仍显示英文 `app_id`（目录名）。

### 12.2 显示变量取值表（管理端）

| 页面/位置 | 显示变量 | 实际来源 | 回退 | 结论 |
|---|---|---|---|---|
| 技能市场卡片主标题 | `s.name` | `/admin/skills` 的 `name`（app_id） | 无 | ❌ 有 title 也不显示 |
| 技能市场卡片副标题 | `v{s.version}` | release.version | `—` | ⚠️ 空版本文案与智能体页不一致 |
| 技能市场徽章「精选」 | `s.quality` | `skillJSON` **不含** `quality` | 无 | ❌ 市场行永不显示 |
| 技能市场徽章「上传包」 | `s.source==='upload'` | `skillJSON` **不含** `source` | 无 | ❌ 永不显示 |
| 技能市场徽章「官方/员工上传/上架」 | `s.official`/`s.channel`/`s.enabled` | skills + 客户端补 channel | 无 | ✅（org 行 `enabled` 未知按未上架，有注释） |
| 技能市场归属 | `s.owner` | 市场=`author`(投影自 apps.owner)；org=审批行 owner | `未指定` | ✅ 语义正确，字段名易误读 |
| 智能体市场卡片主标题 | `a.title \|\| a.name` | `agentJSON.title`（apps.title）；org=`display_name` | `name` | ✅ |
| 智能体卡片副标题 | `· a.name` | app_id | 无 | ✅ 有意显示 slug |
| 审批队列表格「名称 / 标题」 | `row.display_name \|\| row.name` + 下方 `row.name` | org/market 均为 release.title | `name` | ⚠️ title 为空/等于 name 时 slug 重复两次 |
| 审批队列「作者」 | `row.author` | release.publisher | 空串（无 `—`） | ⚠️ 空值显示空白 |
| 审批队列「归属」 | `row.owner` | apps.owner 映射 | `—` | ✅ |
| 审批队列「时间」 | `row.created_at` | 服务端 `2006-01-02 15:04:05` 字符串 | 无 | ⚠️ 无时区标记（服务端时区 vs 北京时间） |
| 平台内置表格「技能」 | `s.title \|\| s.name` + `s.name` | builtin 的 `title` | `name` | ✅ |
| 转移归属弹窗标题 | 三种来源 | Marketplace=`name`；Agents=`title\|\|name`；Capabilities=`display_name` | `name` | ❌ 同一弹窗三种显示 |
| 下架确认（技能页） | `window.confirm` 文本 | `s.name` | 无 | ⚠️ 显示 slug |
| 上传/编辑弹窗标题 | `uploadSkill?.name` / `skillForm.name` | app_id | 无 | ⚠️ 显示 slug |
| 审批预览 key | `row.display_name \|\| row.name + '@' + row.version` | 运算符优先级 | — | ❌ 有 title 时 key **不含版本**，跨版本碰撞 |
| 锁定面板「名称」 | `l.name` | 锁的 name（可预占、无 App 行） | 无 | ✅ 合理（但无说明） |
| 客户端能力中心卡片 | `displayName` | `/capabilities` 的 `display_name` | `name` | ✅ 已正确映射 |

### 12.3 显示变量问题清单（D 系列）

| ID | 级别 | 问题 | 证据 |
|---|---|---|---|
| D-01 | **P1** | 技能市场卡片主标题用 `s.name`；服务端 `skillJSON` 不返回 `display_name`；`Skill` 接口无该字段；组织行归并时丢弃 `display_name` → 所有技能在管理端显示英文目录名 | `Marketplace.tsx:18-55,170-178,425`、`skill_api.go:247-261`、`serverstore/skills.go:15-17` |
| D-02 | **P1** | 管理端无法编辑展示名：skill/agent 的 update 请求无 `Title` 字段、表单无输入框；`UpdateSkillMeta` 只能回写现有 `DisplayName`（空则回落 name）→ legacy/错误标题只能重传归档或改库 | `admin.go:234-239`、`agent_api.go:63-67`、`Marketplace.tsx:68-75,226-236`、`Agents.tsx:263-272`、`skills.go:182-196` |
| D-03 | P2 | `skillJSON` 缺 `quality`/`source`：市场页「精选」「上传包」两个徽章永不渲染（智能体页有 quality，不对称） | `skill_api.go:247-261`、`Marketplace.tsx:430-437` |
| D-04 | P2 | 展示名映射分裂：Agents 页 `display_name→title`，Skills 页丢弃 `display_name`；同一后端字段两套适配 | `Agents.tsx:140`、`Marketplace.tsx:170-178`、`Capabilities.tsx:394` |
| D-05 | P2 | 转移归属弹窗显示名三端不一致：Marketplace 传 `name`、Agents 传 `title\|\|name`、Capabilities 传 `display_name` | `Marketplace.tsx:596`、`Agents.tsx:502`、`Capabilities.tsx:593` |
| D-06 | P2 | 下架确认与上传/编辑弹窗标题用 slug：技能页 `window.confirm(s.name)`、弹窗 `uploadSkill?.name`/`skillForm.name`；智能体弹窗同 | `Marketplace.tsx:299,530`、`Agents.tsx:426,459` |
| D-07 | P2 | 审批预览 key 优先级 bug：`row.display_name \|\| row.name + '@' + version` ⇒ 有 title 时 key 不含版本，跨版本预览碰撞 | `Capabilities.tsx:284` |
| D-08 | P2 | 审批表「名称/标题」：title 空或等于 name 时 slug 重复显示；`author` 空串无 `—`；`display_name` 未 trim | `Capabilities.tsx:394-412` |
| D-09 | P2 | 组织行从审批队列归并时只丢 `display_name`、保留 `quality`：技能页组织行有「精选」但无中文名；与 Agents 页处理相反 | `Marketplace.tsx:170-178` vs `Agents.tsx:140` |
| D-10 | P2 | 同一「无版本」状态三种文案：Marketplace `—`、Agents「尚未发布版本」、Capabilities 直接显示版本/空 | `Marketplace.tsx:427`、`Agents.tsx:325`、`Capabilities.tsx:411` |
| D-11 | P2 | `display_name` 空白/全空格未 trim；`\|\|` 回退在各端各写一次，没有单一 `displayName()` 归一函数 | 各页 `display_name \|\| name` 处 |
| D-12 | P3 | 排序/检索用 `name`（slug）而非展示名；技能页与智能体页无搜索框；中文标题不可检索、排序不直观 | `Marketplace.tsx:186-193`、`Agents.tsx:150-156` |
| D-13 | P3 | 时间字符串无时区标记；下载/调用数字无千分位 | `Capabilities.tsx:416`、`capabilities.go:825` |
| D-14 | P3 | 「作者」语义：市场行=`apps.owner` 投影到 `author`，组织行=`release.publisher`；标签都叫「作者」，来源不同易误读 | `Marketplace.tsx:25-35`、`Capabilities.tsx:354-357,412` |
| D-15 | P3 | 锁面板只显示 slug（锁可先于 App 预占，合理但无说明）；内置页 `source` 字段不渲染 | `capability-lock-panel.tsx:125`、`BuiltinSkills.tsx` |
| D-16 | P2 | 展示名只取 `apps.title`，不回退**展示版本**的 `release.title`：`appToSkill.DisplayName=a.Title`、`agentJSON.title=a.Title`；历史行 app.title 为空而 approved release 有中文 title 时，即使补了 DTO 仍只能显示 slug | `serverstore/skills.go:79-84`、`marketplace/agent_api.go:32-40`、`capabilities.go:866` |

### 12.4 建议修法（显示面，最小改动）

1. **服务端统一展示名契约**：所有能力 DTO（`skillJSON`/`agentJSON`/approvals/shared/capabilities/builtin）统一返回
   `name`（slug）+ `display_name`（= `trim(app.title) || trim(release.title) || name`）+ `quality` + `source` + `channel`；
   `skillJSON` 与 `agentJSON` 的字段差异必须先消除（`title` 可保留别名，但新字段必须齐）。
2. **管理端只写一个适配器**：`displayNameOf(item) = trim(display_name) || name`；卡片主标题用它，slug 作副标题；转移/确认/弹窗全部走它。
3. **补可编辑性**：`skillReq`/`agentReq` 增加 `title`，`UpdateSkillMeta` 显式写 title（trim、空则 name），编辑表单加「展示名」输入；仅管理员可改，审计记录。
4. **修 D-07 的优先级 bug**（加括号），并给 `author` 空值 `—`。
5. **契约测试**：`/admin/skills`、`/admin/agents`、`/capabilities/approvals` 各断言中文 `display_name`、空值回落、组织行不丢字段；UI 测试断言技能卡显示中文标题、slug 为副标题、转移弹窗显示中文。
6. **一次性回填**（可选）：`apps.title` 为空但最新 approved release 有 title 的，按 release 回填（脚本 + 审计），避免历史行仍显示 slug。


---

## 13. 实施状态与文档完整性（2026-10-26 晚追加，Wave2 后更新）

### 13.1 已落地（对账用）

| 范围 | 内容 | 状态 |
|---|---|---|
| 客户端设计 | 四分段 + 计数、类型 chips、搜索、排序、网格/列表、卡片密度、整页详情、骨架卡、空态主操作 | ✅ 已实现（`CapabilityCenterPanel.tsx`） |
| 客户端功能 | F-07 卸载后立即移除/重载、F-08 我上传（`source=own`，pending/rejected 可见）、F-09 官方可更新、F-10 409 仅 `LOCAL_CONTENT` 进确认、F-11 轮询/刷新三区、F-29 `is_owner` 缺失不再误判 | ✅ 已实现 |
| 客户端动作 | 卡片/列表/详情共用 `planCardActionForTab`；key 统一 `kind:name`；`CapabilityDetailDialog` 保留导出兼容 | ✅ |
| 管理端显示 | D-01~D-16：`display_name` 投影与回退、`quality`/`source` 徽章、组织行归并、转移/确认/弹窗标题、可编辑展示名、审批预览 key、空版本/千分位/服务器时间、展示名搜索排序、作者/归属列头解释、内置 source、锁名说明 | ✅ 已实现 |
| 未改 API 语义 | 只增 DTO 字段；owner 仍只走「转移归属」；版本/审批状态机未改 | ✅ |

### 13.2 仍未落地 / 产品待定（Wave2 后）

已落地（Wave1+Wave2）：F-01（含 name 级删除守卫）、F-02、F-03、F-04、F-05、F-06、F-12、F-13、F-14、F-15、F-16、F-18、F-21、F-22、F-23、F-30、F-32、F-33、F-38、F-39、F-40、F-41、F-43、F-44、F-45、F-46、F-48、F-49、F-50、F-51、F-52、F-53；F-54 只读/错误码/版本 chip 等多数已随重构处理。

仍未落地（非本轮写域/待复测）：
- **F-19**：员工面市场版本历史/按版本下载（库里有、接口仍只有 name 级；产品语义待定）。
- **F-20**：author/owner 双字段拆分（org=Publisher、market=Owner 的语义仍不同；管理端已用两列规避）。
- **F-24**：market 已通过/已拒绝的审批历史列表（现有 tab 语义刻意不混；需产品决定是否新增市场历史面）。
- **F-25**：市场「精选」写面（只有 org 版本级 quality；产品待定，UI 不造假）。
- **F-26**：审批队列分页/批量（仍全量）。
- **F-27**：归属冲突码文档 404/409 混用（文档债）。
- **F-28**：死分支/死字段残余（`enabled` 等；影响低）。
- **F-37**：30s 轮询回退安装态的时序判据（seq 守卫已有，极端时序仍需注入测试）。
- **F-42**：同名冲突四码统一（若本轮未完全收敛，标为残余）。
- **F-47**：常量复制/字面量清理（若未完全收敛，标为残余）。
- **F-54**：错误码全量本地化、详情快照、score 展示等残余。
- **F-55**：测试寄居/路由文档/发布规范/release note/dirty 排除/轮询回退等文档债。
- **真机 E2E**：集成脚本 `integration-tests/capability-lifecycle.py` 已入库并通过静态/自检守卫，但**真机运行**需要 Docker+真 server+Xvfb；`e2e-client.mjs` 已更新未跑。

**产品待拍板**：F-19（是否开放市场版本历史）、F-24（市场审批历史面）、F-25（市场精选）、F-26（审批规模化的分页/批量交互）。

### 13.3 文档完整性自检

- [x] 实体/数据模型（6 个实体，含"Review 无表、Installation 服务端不存"）。
- [x] 三套状态机（目录 / 版本 / 安装）。
- [x] 客户端与管理端全部面（四分段、卡片、详情、四个管理 Tab）。
- [x] 员工面与管理面端点清单（含权限与命名空间）。
- [x] 客户端/管理端/三端动作矩阵。
- [x] 不变量与现有判据（11 条 + 测试矩阵）。
- [x] 术语表（上传/发布/上架/审核/安装/卸载/归档/转交）。
- [x] P0/P1/P2/P3 全部问题（P3 合并行的逐条明细见 §13.4）。
- [x] 根因、修复顺序、8 项待拍板。
- [x] 显示变量专项（§12，D-01~D-16）。
- [x] 实施状态与未落地边界（§13.1/§13.2）。
- 说明：§1~§12 的行号是 `80c48abca3` 审计快照；实施后部分行号/结构已变，复盘时以证据语义为准，不要拿旧行号直接定位当前代码。

### 13.4 P3 合并行明细（F-54 / F-55 展开）

**F-54（客户端徽章/排序/搜索/字段）**

1. 已下架/已转交徽章在卡片与详情各渲染一次（重复）。
2. 版本 chip 只对 local 且非 builtin 渲染，口径不一。
3. 「我的」分区"自制组在后"只对未上架成立。
4. 搜索字段口径与内置技能不一致（name/displayName/description vs 仅部分）。
5. `score/downloads/calls/owner/originAppId` 下发但卡片从不展示（`score` 只排序）。
6. 详情弹层持有旧快照，列表刷新后详情可能过期。
7. 无手动刷新入口。
8. 服务端错误码未映射成本地化文案（部分直出英文）。
9. auditor 角色仍看到写按钮（权限只靠 403 兜底）。

**F-55（测试/文档债）**

1. `planCardAction`/`mergeItems` 核心纯函数测试寄居 `packages/host/enterprise/tests/`，包迁走即静默失守。
2. 文档路由路径 `/api/server/admin/approvals` 过期（实际 `/capabilities/approvals`）。
3. 发布规范与 `name==app_id` 规则漂移（D0901:414）。
4. 2026-10-23 契约无 release note（最新 v2.9.1 在 10-22）。
5. `?force=1` 从未落地，宿主不读该 query（D0825:94）。
6. dirty 排除清单未落地（仅剔 `.zeokeel/` + 平台字段）。
7. 30s 轮询可回退刚完成安装态，连续两轮认账未修。
8. 归属冲突码文档 404/409 混用（P0902/P0904 vs publish.go）。
