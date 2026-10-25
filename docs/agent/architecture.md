# 架构规则（可执行的那部分）

> 本文件描述**当前真正被机器判定的**架构约束，以及**为什么有些约束还没开**。
> 判据本体：`.dependency-cruiser.cjs`（TS）+ `server/.go-arch-lint.yml`（Go，基线即配置）；
> 基线：`.dependency-cruiser-known-violations.json`。

## 1. 包级分层（TS，已生效）

```
packages/host/desktop      ← 唯一顶层装配者（Electron 主进程 / packaging / release 测试）
        ▲
packages/host/*            ← host 面能力包（enterprise / connectors / browser / cron / ...）
        ▲
packages/client/*          ← 渲染进程 UI 包（panel-surface / foot-menu / account-card / ...）
        ▲
packages/vendor/*          ← vendored 第三方（memory-evolve），叶子
community/fabric           ← 文档脚手架，未声明可加载入口
```

允许方向：`client → host → vendor`（**向上依赖**）。反向（host 运行期依赖 client、vendor 依赖产品包）
是架构倒置。`desktop` 例外：它是装配者，可以依赖任意 host/client 包。

### 已生效的 8 条规则（`.dependency-cruiser.cjs`）

| 规则 | 判什么 | 为什么 |
| --- | --- | --- |
| `no-circular` | 任意模块环 | AI"顺手加一条 import"最常见的事故；只在特定加载顺序下炸 |
| `no-submodule-internals` | 产品代码直引 `deepseek-harness/**` | 子模块是上游 pin，只能走上游公开包 |
| `no-server-import-from-product` | TS 引 `server/**` | 跨语言只走 HTTP 契约 |
| `client-face-no-host-face` | 同包 `src/client/**` → `src/host/**` | 两个进程/两个 bundle，运行时必然断 |
| `host-face-no-client-face` | 同包 `src/host/**` → `src/client/**` | 同上 |
| `vendor-is-leaf` | `packages/vendor/**` → 产品包 | vendored 代码必须是叶子 |
| `community-fabric-is-scaffold` | `community/**` → `packages/**` | schemas/参考适配器评审前不得声明入口 |
| `host-packages-no-desktop` | 非 desktop 的 host 包 → `packages/host/desktop/**`（`tests/` 例外） | 防止 host 能力包反向依赖装配者 |

### 基线（例外登记）

`.dependency-cruiser-known-violations.json` 当前登记 **5 条存量循环依赖**：

- `packages/host/browser/src/`：`runtime ↔ shots ↔ electron-adapter`、`guard → electron-adapter → runtime → guard`
- `packages/client/wasm-apps/src/client/`：`AppCenterPanel ↔ catalog-filter`
- `packages/vendor/memory-evolve/src/client/`：`index ↔ PromptView`

纪律：
1. **基线只能缩不能放**。修掉一条就从基线里删一条（重跑 `--output-type baseline` 会自然收缩）；
2. 新增违规**必须修**；确需接受，必须在 PR 里写明理由并更新基线（可评审的 diff）；
3. 每次扫描都带 `--ignore-known`，否则存量会让门禁恒红（等于没有门禁）。

### 命令

```bash
# 门禁形态（err 报告器才会以非零退出码表达违规；json 报告器不设退出码）
corepack yarn dependency-cruiser packages community \
  --config .dependency-cruiser.cjs \
  --ignore-known .dependency-cruiser-known-violations.json \
  --output-type err

# 等价 target
make -f Makefile.agent arch-ts

# 刷新基线（仅在有意接受存量时；改完把 JSON diff 交给评审）
corepack yarn dependency-cruiser packages community --config .dependency-cruiser.cjs \
  --output-type baseline > .dependency-cruiser-known-violations.json
```

### 已知边界

- 只判 **AST import/export**（SWC 解析），不做类型推断；`import type` 不计为运行期依赖。
- `.d.ts/.d.mts/.d.cts` 不进扫描（声明不产生运行期依赖，且 SWC 对"合法但无初始化"的
  `declare const` 会报语法错，导致整次扫描中止）。
- **尚未开启**：`host/**` → `packages/client/**` 的运行期反向依赖（`import type {}` 的
  类型增强是既有的、有意的用法；需要先区分"类型增强"与"运行期引用"再开规则）。
- **尚未开启**：`client/**` → `packages/host/desktop/**`（`account-card` 依赖 `enterprise`
  是已声明的；desktop 反向被 client 依赖目前没有声明面，需要先补 package.json 契约）。

## 2. 包内"双面"约定

有 `src/host/` 与 `src/client/` 的包（`enterprise`、`capability-center`、`wasm-apps-host` 等）
必须满足：**host 面（主进程）不引 client 面（渲染进程），反之亦然**。跨面通信只能走：

- Cordis 服务/事件（host 注册，client 消费）；
- 已声明的子路径导出（`@zeokeel/dsh-x/client`、`/loopback` 这类**外部契约**）；
- HTTP（本机回环接口，见 `loopback` 模块）。

## 3. Go 侧：包级依赖判据（**已启用，基线即配置**）

判据 = `server/.go-arch-lint.yml`（`go-arch-lint v1.19.0`，schema version 3）。入口：

```bash
make -f Makefile.agent arch-go      # 秒级（实测 1.7–3.9s，视机器负载）；exit 0 = 没有新增包级依赖边
```

### 门禁状态：**只有手动入口，当前不进 `yarn check` / CI**

Go 基线的地位是"**已启用、但未门禁化**"，别把它读成"已被 CI 守住"：

- 唯一入口是上面的手动 target。`yarn check` 的第 19 条根守卫 `check:architecture`
  （`scripts/check-architecture.mjs`）**只跑 TS 那一半**（dependency-cruiser），不含 Go。
- 因此合并前**必须人手跑一次**并在 PR 里贴 `make -f Makefile.agent arch-go` 的 exit 0 输出；
  漏跑 = 这条判据对本次改动等于不存在。
- **为什么还没进**：为了把 TS 侧门禁化，`check-architecture.mjs` 只依赖根 devDependencies 里的
  dependency-cruiser（`yarn install` 即得）；Go 侧要额外在 CI 装**不入库的外部二进制**
  （`go install github.com/fe3dback/go-arch-lint@v1.19.0` + 目录缓存），并且新增/修改门禁
  要同时改 `scripts/check-workspaces.mjs` 的登记、`scripts/check-root-guards.mjs` 的
  `REGISTERED_GUARD_ENTRIES` 与摘要、`scripts/verify-check-workspaces.mjs` 的第二判据、
  以及 workflow —— 按 AGENTS.md §4「改判据 = 改结论」，这是**独立提交 + 独立评审**的一件事。
- **后续接入路径**（谁做谁评审）：①CI 的 gate/server job 增加
  `make -f Makefile.agent install-arch`（或缓存 `server/temp/{gopath,gomodcache,gocache}`）
  + `make -f Makefile.agent arch-go`；②或先把 arch-go 挂到 `server/Makefile` 的 `check-fast`
  前置（本地内循环即覆盖）；③两种都按上面的登记/摘要/第二判据流程登记成根守卫，
  并把这一节改写成"已门禁化"。

### 判什么、不判什么

- **判**：`server/cmd/**` 与 `server/internal/**` 的**包级 import 方向**（`go/parser`，只读
  import 声明）。这比"某个文件能不能 import 某前缀"更贴要防的 bug：**放错层**。
- **不判**：第三方依赖方向（`allow.depOnAnyVendor: true`）；方法调用/依赖注入
  （`allow.deepScan: false` —— 它要跑 `go/packages`，需要可写 build cache 与完整模块下载，
  且给出与声明式 import 图不一致的告警）；**测试文件**（`excludeFiles: ^.*_test\.go$`）；
  `testdata/`（WASM 夹具与 guest 源码）、`demoapps/`、`scripts/`、`skills/`、`temp/`
  （都不参与 server 二进制构建）。
- 为什么不用 `depguard`：它只判"文件能不能 import 某前缀"，不判层次/方向；`go-arch-lint`
  直接比对"实际依赖图 vs 声明图"。安装与版本见 `toolchain.md` §2.2。

### 组件划分（64 个）

| 组件 | `in` | 说明 |
| --- | --- | --- |
| `cmd` | `cmd/**` | 唯一顶层装配者，`anyProjectDeps: true`（main 的职责就是接线，不逐条登记） |
| `internal/<pkg>` 命名的组件 | `internal/<pkg>` | 一个包目录一个组件；名字 = 目录去掉 `internal/`、`/` 换成 `-`（`internal/wasmapp/api` → `wasmapp-api`） |
| `webadmin` | `webadmin` | `cmd/server` 里 `go:embed` 嵌进二进制，是**真** import 边 |

`wasmapp` 的每个子包各算一个组件：`go-arch-lint` 的 `in` 是**目录精确匹配**，
`internal/wasmapp` 并不覆盖它的子目录。因此**新增包目录必须同步加 component**，
否则 arch-go 直接报 `File ... not attached to any component`（fail-loud，不会静默放过）。

### 当前基线的形状（2026-10-26 机械生成）

- **198 条允许边**（64 个组件 = 1 个 `cmd` + 51 个有出边 + 12 个纯叶子；叶子：`archiveutil`、`channel`、`clientrelease`、
  `features`、`limits`、`util`、`wasmapp-apperr`、`wasmapp-cachetrust`、
  `wasmapp-refapp-{sockprobe,stdprobe,wasiprobe}`、`webadmin`）；`cmd` 走 `anyProjectDeps`。
- 扇入集中：`serverstore` 被 **24** 个组件依赖（+`cmd`）、`limits` 22、`serverauth` 14、`util` 13；
  扇出集中：`wasmapp-api` 27 条出边、`router` 17 条且**只被 `cmd` 引用**。
- **生产构建的包级图是 DAG（无环）**：没有 SCC>1。`cmd` 是唯一入口，`router` 是"装配后的
  路由表"而非被业务包反向引用的中转站。
- 但**环只存在于测试文件里**（4 个 SCC，全部由 `*_test.go` 闭合，2026-10-26 独立复算）：

  | # | 测试期 SCC（组件名） | 闭合方式 |
  | --- | --- | --- |
  | 1 | `limits ↔ wasmapp-abi` | `wasmapp-abi` 生产引 `limits`；`limits` 的测试引 `wasmapp/abi` |
  | 2 | `agentshare` / `appstore` / `archiveutil` / `deployconfig` / `serverauth` / `serverstore` / `sharedskills` / `skillmanifest` 一团 | 8 个组件间的往返边全部来自这些包的 `*_test.go` |
  | 3 | `reports ↔ router ↔ wasmapp-api` | `router` 生产引 `reports` 与 `wasmapp/api`；`reports` 的测试引 `router`，`wasmapp/api` 的两个**带 build tag** 的测试文件（`audit_s72_deep_static_upgrade_test.go`、`audit_r25_serving_appid_route_test.go`）也引 `router` |
  | 4 | `wasmapp-assets ↔ wasmapp-wasmmod` | `wasmmod` 生产引 `assets`；`assets` 的测试引 `wasmmod` |

  注意第 3 组：`wasmapp-api → router` 只出现在**带 build tag 的测试文件**里，而 `go-arch-lint`
  不评估 build tag（`go/parser` 只读 import），`go list` 却看不到这些文件 —— 复算时若用
  `go list` 会得出两组件环甚至无环，必须用"不评估 build tag"的口径（或直接读文件数 import）。
- 这正是**故意**排除测试文件的原因：把测试 import 也算进来会多出 **87 条违规命中**
  （涉及 **26** 个组件、**65** 个「组件 × import 包」对 = **50 条跨组件边** + **15 条外部测试包
  import 自身包** 的命中；**命中数 ≠ 唯一边数**，别把 87 当成 87 条边），"理想分层"配置第一天就恒红。
  想连测试侧一起拦：临时删掉 `excludeFiles` 那行跑一次（`go-arch-lint check --output-type json`
  里 `ArchWarningsDeps` 就是完整清单），再逐条补进 `mayDependOn` —— 那是**另一次**评审，不是顺手改。

### 诚实结论：这不是"理想分层"

基线冻结的是**现状**，不是正确设计。`serverstore` 事实上是数据访问中枢（24 个上游），
`router` / `wasmapp/api` 都是大扇出装配点；`util`、`limits` 虽然是叶子，但"叶子"目前只靠
**暂时没有反向需求**维持，不是编译面约束出来的。判据的作用是"**不许再多一条**"，
**不是**"已经分好层"，别拿它当分层完成的证据。

另外：本文件上一版记录的 4 组反向依赖（`serverauth ↔ serverstore`、`router ↔ wasmapp`、
`util → serverauth`、`reports → router`），按**当前生产 import 复测已不成立**：
`serverauth → serverstore`、`router → wasmapp/api` 是**单向**正向边（反向不存在），
`util → serverauth` 根本不存在（`util` 是纯叶子），`reports → router` 只剩测试 import。

### 新增一条边 = 改配置 + 评审

不允许"先让 arch-go 红、再眼过"。任何新增的包级依赖必须：

1. 在 `deps.<组件>.mayDependOn` 里加一行（`cmd` 除外，它本来就是任意依赖）；
2. 同一个 PR 里说明**为什么下沉/接口/回调都不行** —— 评审面就是这一行 diff；
3. 在 `changes/` 留记录，`acceptance` = "`make -f Makefile.agent arch-go` exit 0，且新增行被评审"。

为什么这么严：`mayDependOn` 是**唯一**可执行的 Go 分层判据，放松它 = 放松整条门禁，
所以按 AGENTS.md §4 的"改判据 = 改结论"对待（单独提交、单独评审）。

### 只收紧：删边 + 回归

修掉一条不该存在的依赖后，**立刻**从配置里删掉对应的 `mayDependOn` 行；此后任何人把它加回来，
`make arch-go` 立刻红 —— **配置本身就是回归判据**，不需要另写用例去断言"不许 import"。
作业顺序（先绿 → 删边 → 仍绿；仍红说明还有别的文件在用这条边，先修完再删）：

```bash
make -f Makefile.agent arch-go     # 1) 先确认绿
# 2) 删掉 deps.<X>.mayDependOn 里的 <Y>，再跑
make -f Makefile.agent arch-go     # 3) 必须仍 exit 0
```

### mutation 自证（判据真的在判吗）

判据最怕"配置写错但恰好绿"。自证方式：**新建一个文件**注入一条基线没有的边（比改现有文件安全，
不碰任何生产代码，`rm` 即还原；实测 2026-10-26）：

```bash
cd server
cat > internal/util/zz_arch_probe.go <<'EOF'
package util

import _ "github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
EOF
cd .. && make -f Makefile.agent arch-go    # 必须非 0，且点名：
# Component util shouldn't depend on .../internal/serverstore in .../internal/util/zz_arch_probe.go:3
rm server/internal/util/zz_arch_probe.go
make -f Makefile.agent arch-go             # 必须回到 exit 0（OK - No warnings found）
```

实测结果：注入 → exit 2 + 1 条 `shouldn't depend`（点名 `util` 与目标 import 及文件:行）；还原 → exit 0；
两次都是秒级（实测 1.7–3.9s，视机器负载）。二进制缺失或配置被删时 `arch-go` 一律 **exit 2**
（分别指向 `toolchain.md` §2.2 与本节）：删配置等于删判据，绝不静默通过。

## 4. 其他硬边界（不在 dependency-cruiser 里，但同样不可破）

- `deepseek-harness/` 是上游子模块：**永不编辑**；升级只动 pin。
- `packages/host/desktop/` 拥有 Electron 引导、打包与发布测试；品牌资源唯一真源是
  `brands/official/`，所有图标/标识必须由它派生。
- Go API 契约集中在 `server/internal/router`：`/api/server/*` 管理面、`/api/client/v2/*` 客户端面；
  旧前缀（`/api/*`、`/v1/*`、`/v2/api/*`、`/v2/v1/*`）已删，**不得加回**。
