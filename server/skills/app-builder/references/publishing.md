# 发布与运维参考

> ⚠️ **怎么发布（先读这一段）**
>
> 发布不需要你手工拼请求：客户端内置了工具，直接调用即可。登录态、上传超时、
> 大文件分片与断线续传都由客户端处理，你只要给出应用标识、产物路径与配置声明。
>
> | 工具 | 用途 |
> | --- | --- |
> | `wasm_app_list` | 列出应用中心里的应用：确认标识有没有被占用、查当前版本号（新版本号必须比它大） |
> | `wasm_app_validate` | 预检：静态校验 + 真编译 + 干跑。**不占版本号、不进审计**，失败也能反复调 |
> | `wasm_app_publish` | 发布新版本：同步执行，超过 8 MiB 自动分片续传；**失败不占版本号** |
> | `wasm_app_schema` | 读表结构（表/列/行数/占用）。**发布后确认 `db.define` 真的生效** |
> | `wasm_app_diagnostics` | 读运行诊断（失败码 + 可操作 hints）："先读诊断，再改代码"的那个入口 |
> | `wasm_app_rows` | 读某张表的一页行（缺省 50、最多 200）。**敏感列默认脱敏且本工具无法解掉**（原值只能由人在客户端点「显示原值」） |
>
> 一次典型的发布（先在会话工作区把产物编译好，再调工具）——`wasm_app_publish` 的参数：
>
> ```json
> {
>   "appId": "shared-notes",
>   "version": "1.0.0",
>   "title": "共享便签",
>   "wasmPath": "/workspace/shared-notes/main.wasm",
>   "changelog": "首个版本",
>   "config": {
>     "access": "whitelist",
>     "whitelist": ["zhangwei", "lisi"],
>     "purpose": "小组共享便签：写值班记录与交接事项",
>     "data_sensitivity": "internal",
>     "owner": "zhangwei"
>   }
> }
> ```
>
> 顺序：先 `wasm_app_validate`（同样的参数，`changelog` 可以不带）把错误改完，
> 再用**相同的参数**调 `wasm_app_publish`。失败时结果里带 `code` / `details` / `hints`，
> 按 hints 改完重发即可 —— 失败的发布不占版本号，可以用同一个版本号重发。
> 上一次发布断在 `UPLOAD_INCOMPLETE` 时，把它 `details.upload_id` 原样填进 `uploadId` 继续传。
>
> - `access` 写侧只有 `login`（登录后全员可用，**缺省**）/
>   `whitelist`（仅名单内用户；选它时名单必须非空）；历史 `public` 读取侧按 `login` 处理，
>   新版本不要再写。平台没有匿名面。
> - `changelog`：给已有应用发新版本时**必填**；首版可以不带。
> - 员工也可以自己在客户端「应用中心」里上传发布（手动路径，效果完全一样）。
> - **不要用 `curl` 直接调服务端接口**：那需要员工的登录令牌，你既拿不到，也不该
>   把它写进任何命令或日志里。需要发布就用上面的工具。

> 上限数字一律以 `references/limits.md`（从平台源码生成）为准；本文件只讲流程。

## 0. 确认工具链（先做这一步）

**平台不做构建**：编译发生在员工本机（或 AI 的会话工作区），平台只收 `wasm32-wasip1`
产物。所以第一件事是确认这台机器上真的有 Go，且版本够用：

```bash
go version
```

- 打印出 `go version go1.2x.y <os>/<arch>` ⇒ 继续第 1 步。
- 打印 `command not found`（Windows 上是「不是内部或外部命令」）⇒ **停下来，不要硬试**：
  直接告诉用户"这台机器上没有 Go，装好 Go 1.21 或更高版本才能编译应用"，并给出两条出路：
  ①装 Go（官方下载页；装完**重开客户端**再试，否则 PATH 不会刷新）；
  ②换一台已装 Go 的机器，把应用工程拷过去编译。
  **不要指望在会话里下载安装包或用包管理器装 Go**（会话的可用能力由宿主与网络策略决定，不要假设它有外网）：装 Go 请走上面两条出路。⚠️ 注意措辞：这条约束说的是**构建会话**，与"应用运行时能不能联网"是两件事 —— 后者的准确口径见作者手册 §1.1 / 总纲 §6（**应用不能主动发起 `XHR`/`fetch` 型网络请求**；**不得对外宣称"不能联网"**）。
- 打印出的版本低于 `go1.21` ⇒ 同样停下并说明原因：`wasip1` 端口从 Go 1.21 起才稳定提供，
  更早的版本编不出平台要的产物。
- **不要改用 Python / Node / Java 实现**：平台只接受 wasm，Go 是官方支持的语言
  （Rust 的 `wasm32-wasip1`、Zig 实测可用但不承诺）。语言选错=整件事做不完。

## 1. 本地编译

### 1.1 固定步骤：四条状态目录全部指向会话工作区

**这一步是黄金路径的一部分，不是建议**。会话工作区是唯一可靠的可写位置，
`$HOME` 下的缓存目录（`~/.cache/go-build`、`~/go/pkg/mod` 等）在受限环境里可能
不可写或不可见 —— 先跑下面这四行，再编译：

```bash
export GOCACHE="$PWD/.gocache" GOMODCACHE="$PWD/.gomodcache" GOPATH="$PWD/.gopath" TMPDIR="$PWD/.tmp"
mkdir -p "$GOCACHE" "$GOMODCACHE" "$GOPATH" "$TMPDIR"

GOOS=wasip1 GOARCH=wasm go build -o shared-notes.wasm .
```

四条一个都不能少：`GOCACHE`（编译缓存）、`GOMODCACHE`（依赖模块）、`GOPATH`、
`TMPDIR`（编译器/链接器临时文件）。Windows PowerShell 里等价写法：

```powershell
$env:GOCACHE="$PWD\.gocache"; $env:GOMODCACHE="$PWD\.gomodcache"; $env:GOPATH="$PWD\.gopath"; $env:TMPDIR="$PWD\.tmp"
New-Item -ItemType Directory -Force $env:GOCACHE,$env:GOMODCACHE,$env:GOPATH,$env:TMPDIR | Out-Null
$env:GOOS="wasip1"; $env:GOARCH="wasm"; go build -o shared-notes.wasm .
```

### 1.2 漏了这一步会看到什么（逐字）

```
package fmt is not in std (/usr/local/go/src/fmt)
```

**看到这一行时不要去找"标准库被裁剪了""Go 装坏了""要不要重装 Go"** —— 它与标准库
本身无关，只有一个原因：`GOCACHE`（或 `GOMODCACHE`）指向了不可写的目录，Go 无法建立
构建缓存，于是连标准库都无法编译进产物。同一族的报错还有
`read-only file system`、`go: creating work dir: mkdir ...: permission denied`、
`cannot find GOROOT directory`。处置办法只有一条：回到 §1.1，把四条环境变量重新导出、
目录真的建出来（`mkdir -p` 那行不能省），再重跑 `go build`。

其余约束：

- 产物上限 32 MiB；编译超时 60 秒；编译失败平台会回结构化错误，**失败的发布不占版本号**。
- 组件模型（`wasm32-*-component`）产物不受支持，预检会直接拒。


## 2. 本地自测（零依赖）

Node 自带 `node:wasi`，可以直接把产物跑起来 —— `examples/go/preview.mjs` 就是一个假宿主：
它按 ABI 收发帧、用内存数据应答宿主调用、**按宿主规则直出包内静态资源**（所以要先打包，
见 §2.1）、打印最终响应。

```bash
node preview.mjs shared-notes.wasm
node preview.mjs shared-notes.wasm --path /api/notes --method POST --body '{"body":"hello"}'
node preview.mjs shared-notes.wasm --user someone-else       # 看无权限页
```

**这一步能发现绝大多数问题**：帧格式写错、忘了 flush、响应没写、白名单分支、路由分支、
静态资源没打进包。本地预览验证不了的只剩"真实数据库/真实 AI/真实体积" —— 那些交给预检。

## 2.1 把前端资源打进 wasm（发布前的固定一步）

平台把 wasm 的**自定义段**当作随包静态资源的一等载体（段名 = 包内逻辑路径）：宿主按路径
直出（宿主直出的完整路由规则见 `references/abi.md` §3.7），应用也能用 `assets.read` 读。
用官方打包器（在技能目录的 `scripts/` 下）把 `web/` 打进去：

```bash
mkdir -p dist
node scripts/pack-assets.mjs --in shared-notes.wasm --out dist/shared-notes-packed.wasm \
  web/index.html=index.html web/app.css=static/app.css web/app.js=static/app.js
```

- `SRC=DEST`：`SRC` 是磁盘上的文件，`DEST` 是**包内逻辑路径**（也就是段名），可重复。
- `--out` **必填且不得与 `--in` 同路径**（原产物要留着继续编译/重打包）。
- `zeokeel.app.json` 与工具链元数据段名（`name` / `producers` / …）会被直接拒 ——
  保留资源由平台在发布期写入，名单放 `config` 的 `whitelist`。
- 路径不超过 256 字节、单段不超过 255 字节；自定义段总量不超过 4 MiB。
- 打包器与演示应用用的是**同一份实现**：唯一源在平台仓库的
  `server/demoapps/scripts/pack-assets.mjs`，镜像构建期注入到技能目录的 `scripts/`
  —— 在已安装的技能目录里路径就是上面的 `scripts/pack-assets.mjs`。
- **`__zeokeel/` 前缀不能占用**（宿主保留命名空间，发布期 `ASSET_DENIED` +
  `details.reason = "reserved_path_prefix"`）。

## 3. 应用配置文件 `zeokeel.app.json`

随发布一起提交（**不计入 wasm 体积上限**），发布期由平台连同随包资源一起收进该版本的
资源集（运行期常驻内存，不落盘），应用用 `assets.read("zeokeel.app.json")` 读它。

**字段规格（字段名 / 类型 / 必填 / 取值 / 上限）只在生成物里维护**：
`references/app-config.md`（由平台的 `appcfgspec.go` 生成，含应用配置字段与发布载荷字段）。
本文件不复制那张表 —— 手抄一份必然与平台漂移（历史教训：`title` 的服务端首版必填没写进表）。

规则（语义部分，字段表里没有）：

- `access` 写侧只有 `login`（要求登录，登录后全员可用，**缺省**）/
  `whitelist`（要求登录 + 名单准入）；历史 `public` 读取侧按 `login` 处理，新版本不要再写。
  `access="whitelist"` 且名单为空 ⇒ **拒绝发布**。
- 白名单里写了不存在的账号 ⇒ **允许发布**（否则等于提供一个账号枚举接口）；
  拼错只能靠"无权限页显示本人账号"闭环发现。
- **改配置 = 发新版本**（运行期改不了）；顶层字段集合是封闭的：多一个未知字段即拒。

## 4. 发布流程

| 步骤 | 端点（管理面只在平台主站；应用在客户端内以 `<渠道 app 源 scheme>://<app_id>` 打开，渠道参数化，拿不到管理面） | 说明 |
| --- | --- | --- |
| 预检 | `POST /api/client/v2/apps/wasm/validate` | 静态检查 + 真编译 + 合成帧干跑；**不占版本号、不进审计** |
| 标识预查 | `GET /api/client/v2/apps/wasm/:app_id/availability` | 只读：标识唯一性 / 保留字（不编译、不占号、不进审计） |
| 提交新版本 | `POST /api/client/v2/apps/wasm/:app_id/releases` | **同步**：成功才落版本行；请求体含 wasm + `version`/`title`/`changelog` + 应用配置文件 |
| 版本历史 + 审核结论 | `GET …/wasm/:app_id/releases` | 自己应用的版本清单、状态（`pending`/`rejected`/`approved`/`withdrawn`）与被拒理由；**审核结论唯一的作者侧出口** |
| 部署历史 | `GET …/wasm/:app_id/deployments?limit=` | `current_version` / `current_deployment_id` / `current_release_id` + 历史行；`current` 由**部署指针**判定 |
| 部署 / 回滚 | `POST …/wasm/:app_id/deployments` | 体 `{"version":"x.y.z","message":"…"}`；**回滚 = 用旧版本再部署一次**（不重传、不重审） |
| 撤回待审版本 | `POST …/wasm/:app_id/releases/:version/withdraw` | **只对 `pending`**：置 `withdrawn`、释放制品字节、版本号永久占用 |
| 恢复软删 | `POST …/wasm/:app_id/restore` | 保留期内可恢复；恢复后 `enabled` 仍为 0（**不自动上架**），部署指针已复位 |
| 上架 / 下架 | `POST /api/client/v2/apps/wasm/:app_id/publish` · `…/unpublish` | 发布者自主操作，与审核开关无关 |
| 冻结 / 导出 / 删除 | `POST …/wasm/:app_id/freeze` · `GET …/export` · `DELETE …/wasm/:app_id` | 冻结 = 停止服务 + 下架 + 进入只读保留期（`retirement_snapshot_retention_days` = 90 天）；导出 = 控制面元数据 JSON（**不含**应用库里的业务数据），`?database=1&assets=1` 可导出库快照/资源；删除 = **软删**（标识与版本号永久占位）。**保留期到期后平台会真删**制品、应用库与快照（快照在冻结/删除时生成；已清除后不可恢复，元数据与部署历史留作审计） |
| 诊断 | `GET …/wasm/:app_id/diagnostics` | 最近失败与被杀记录（见 `references/diagnostics.md`） |
| 自省 | `GET …/wasm/:app_id/schema` | 表结构与占用（仅发布者可见，并写审计） |
| 数据 | `GET …/wasm/:app_id/rows?table=&limit=&offset=&unmask=` | 某张表的一页行（仅发布者；**默认脱敏**敏感列，原值需显式 `unmask=1` 且单独记审计） |
| 应用中心 | `GET /api/client/v2/apps/wasm/catalog` | **全部应用**的列表（名称 / 一句话说明 / 负责人 / 访问级别 / 是否下架） |

版本号与占号（两条**不同**的规则，不要互相推导）：

- 版本号必须形如 `x.y.z`（可带 `-prerelease`）并**严格递增**；非首版必须写 `changelog`。
- **失败的发布不落行 ⇒ 不占号**：编译/干跑失败后可以直接重发同一个版本号。
- 一旦落了行，**版本号永久占用**：被拒的、被软删的版本都不能复用（换号重发）。
- 保留最近 3 个曾生效版本；更早的版本软删并清空制品（制品总量按人计，不超过 1 GiB）。

谁发布的谁是负责人：

- 第一个成功发布某个 `app_id` 的人**永久占有它**（删了、下架了也还是他的）；
- 只有他能发新版本、上下架、改配置、删除；其他人只能使用；
- 平台管理员可以兜底接管（离职、恶意应用等）；**AI 只是编辑器，发布者记的是发起人**。

更新审批（组织级开关，默认关）：

- 关闭 ⇒ 新版本发布后直接生效；
- 开启 ⇒ 新版本进待审队列，**线上仍是旧版本**（不影响使用），管理员通过后生效；
- **`approved` ≠ 线上**：审批通过只部署**本次被批准的那一版**，且按 SemVer 只有比当前生效
  版本新才真的切指针 —— 它**不会**把线上跳到别的更新版本，也**不会撤销**你之后做的回滚；
- **`rejected` 是终态**：被拒版本**不可改判通过**（`409 APPROVED_NOT_REJECTABLE` 是反方向的
  同族），字节在拒绝时释放、版本号永久占位 ⇒ 改完发**更高**的版本号。

## 4.1 版本与部署：回滚、撤回、恢复、审核结论

三条只读 + 三条动作，构成"线上跑的是哪一版 / 怎么退回去"。四条的鉴权都是**发布者本人或超管**，
非本人一律 **404**、与"应用不存在"逐字节同形。

| 想做的事 | 端点 | 语义要点 |
| --- | --- | --- |
| 看我的版本与审核结论 | `GET …/:app_id/releases` | 状态 `pending` / `rejected`（带理由）/ `approved` / `withdrawn`；返回体不含制品字节 |
| 看部署历史 | `GET …/:app_id/deployments?limit=` | `current_version` / `current_deployment_id` / `current_release_id` + 历史行；`current` 由**部署指针**判定（不是"最新一行"） |
| **回滚** | `POST …/:app_id/deployments`（`{"version":"x.y.z","message":"…"}`） | **回滚 = 用旧版本重新部署一次**：不重传、不重审、不改写历史；目标已是当前版本 ⇒ `changed:false`（幂等，不追加历史、不写审计） |
| 撤回待审版本 | `POST …/:app_id/releases/:version/withdraw` | **只对 `pending`**：置 `withdrawn`、释放制品字节、**版本号仍永久占用** |
| 恢复软删 | `POST …/:app_id/restore` | 保留期内可恢复；恢复后 `enabled` 仍为 0（**不自动上架**），部署指针已复位 ⇒ 先发布/部署一个仍有字节的版本，再上架 |
| 标识预查 | `GET …/:app_id/availability` | 只读（不编译、不占号、不进审计） |

动作的错误码都带可操作 hints：`RELEASE_NOT_DEPLOYABLE`(409，不是 approved) /
`RELEASE_NOT_PENDING`(409，撤回只对 pending) / `RELEASE_BYTES_RELEASED`(409，制品字节已释放) /
`APP_FROZEN`(409，先解冻) / `APP_DELETED`(409，先 restore) / `APP_PURGED`(410，保留期到期已真删)。

五条硬语义：

1. **版本状态与"线上"是两件事**：生效版本只认**部署指针**；`approved` 只说明"这一版可以上线"。
2. **回滚只切制品版本**：`title` / 配置 / 访问级别跟着**版本**走（回滚到 v1，线上就是 v1 的配置）；
   版本号、发布者、归属都不变。
3. **撤回只对 `pending`**；`approved` / `rejected` / `withdrawn` 是终态。要把已上线版本下线，
   请**部署另一个版本**（回滚）或下架/冻结 —— 没有"撤销上线"这个动作。
4. **恢复不等于上架**：`restore` 之后必须显式 `publish`。
5. **版本号永久占用**：被拒、被撤回、被软删的版本号都不释放，唯一出路是发更高的版本号。

### 回滚**只切换制品版本，不恢复应用库**（应用库按 `app_id` 定位，跨版本共享）

- 应用库**按 `app_id`** 定位（`server/internal/wasmapp/appdb/appdb.go` 的
  `SafePath(dataRoot, appID)`）：一个应用**只有一份库文件**，所有版本共用同一份数据。
- 所以回滚**不会**把库恢复到旧版本当时的样子（没有库快照回放，也没有按版本分库）。典型后果：
  v2 改了表名/删了列 → 回滚到 v1 → v1 的代码读到空表或"列不存在"，
  **看起来像"回滚把数据弄丢了"，其实数据还在、只是结构对不上**。
- 正确做法：① 改结构用**新表名 + 双写/迁移列**，让新旧两版都能读；② 回滚前后用
  `wasm_app_rows` 抽查关键表；③ 数据要"修回去"只能**发新版本**（带迁移逻辑的 v3）；
  ④ 留档走保留期内的导出（`?database=1&assets=1`），那是运维动作、不是回滚。
- `restore` 之后"恢复成功但打不开"是设计内行为：部署指针已复位，先发布/部署再上架。

### **AI 工具面没有回滚 / 撤回**

宿主提供给模型的工具只有六个：`wasm_app_list` / `wasm_app_validate` / `wasm_app_publish` /
`wasm_app_schema` / `wasm_app_diagnostics` / `wasm_app_rows` —— **没有**部署（回滚）、撤回、
恢复，也没有"读审核结论"的工具。⇒ **AI 可以发布；回滚 / 撤回 / 恢复必须在客户端「应用中心」
里由人操作。** 不要声称已回滚，也不要编造"已撤回"的结论；需要这三个动作时直接告诉用户去哪儿点。

## 5. 访问模式与"应用能不能用"

三件事互相独立，别混为一谈：

1. **应用中心一律列出全部应用**（无论有没有权限、是否下架）：条目里给出
   访问级别（`access`）与是否已下架，由使用者自己判断该不该点。
   **没有"隐藏应用"这种模式** —— 不想给人用就把 `access` 设成 `whitelist` 并只填该给的人。
2. **一律要求登录**：平台没有匿名面，也没有"未登录先跳登录"这一说 ——
   应用只在桌面客户端内、以登录态打开（§6 的打开与分享）。
3. **谁能真正使用由 `whitelist` 决定，判定在应用自己里做**（平台不比对名单）：
   不在名单的请求照样进应用，由应用返回无权限页面（**必须显示本人账号**）。
   `access="login"` 表示"登录后全员可用"，此时名单为空是合法的。

## 6. 打开与分享（没有"应用地址"）

- 应用**只在桌面客户端内打开**：客户端「应用中心」点开，或点开别人给的**深链**
  `<渠道 scheme>://app/<app_id>`。scheme 由该客户端的渠道配置决定
  （不同渠道的客户端 scheme 可能不同），**不要写死 `zeokeel://` 之类**。
- **没有浏览器地址**：不存在 `<app_id>.<域名>` 形式的 URL，平台也不签发应用域名/证书；
  把 `app_id` 说清楚就够了，不要给用户编造链接。
- 应用在客户端里的 origin 是 `<渠道 app 源 scheme>://<app_id>`（渠道参数化：official/beta 取值 `zeokeel-app`；每个应用一个 origin）；
  自定义协议下 cookie 不可用（`document.cookie` 恒为空、`Set-Cookie` 不落盘），
  所以**应用状态只能放应用库**（`db.*`），不要设计任何依赖 cookie 的功能。

## 7. 上传与体积

- 上传请求体不超过 48 MiB（wasm 以 base64 传输，编码后比原体积大约三分之一）。
- 客户端上传超时 90 秒 > 服务端读取超时 60 秒：**更大的包不要硬传**，把资源精简或
  把大文件移出应用（先 gzip，再以 base64 或自定义段内嵌）。
- 上传频率：每人每小时 30 次（预检 + 发布合计），同一时刻只允许 1 个编译中的上传；
  超了会拿到 `RATE_LIMITED` / `COMPILE_BUSY`，等一会儿再试。
- 自定义段（内嵌资源的一种常见做法）总量不超过 4 MiB（超了报 `SECTION_OVERRIDE_OVERSIZE`）。

## 8. 纪律

- **管理面只在平台主站**：`/api/client/v2/apps/...` 这一族接口**不接受应用页面的请求** ——
  应用页面（`<渠道 app 源 scheme>://<app_id>`）的请求只经客户端的协议转发走到应用请求端点；
  在自己的应用页面上就能调管理接口，等于自管自批，审批与权限边界一起失效。
- 关键操作都写审计：发布结果（成功/失败/被拒）、上下架、冻结/导出/删除、审核开关变更。
- 预检不进审计、不占号：不确定就多预检几次。
