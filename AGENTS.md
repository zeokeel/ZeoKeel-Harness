# ZeoKeel Harness repository rules

## 铁律 0（最高优先级）：渠道与客户身份**永不进本仓**

**本仓是公开仓**（GitHub `zeokeel/ZeoKeel-Harness`）。渠道 / 客户身份属**私有仓** `zeokeel/channels`，
本仓只保留占位符。

**禁止出现**（任何位置、任何形态）：

- 渠道 id、渠道显示名 / 短名 / 产品名、客户或 OEM 品牌名（含其中英文写法、拼音、缩写）；
- 客户自有或被投递环境的**真实域名、主机名、IP、目录名、容器名、镜像 tag、`.env` 取值**；
- 上面的名字出现在**示例、夹具、断言、注释、脚本默认值、文档正文、表格、代码块、URL** 里。

**这一条同样适用于 git 提交信息（subject 与 body）与 GitHub 的 PR / Release 文案** ——
提交信息是公开且可检索的，泄露面与文件正文完全相同。写提交信息时用中性表述：
「某客户渠道」「第二个渠道栈」「渠道 A」；需要具体身份时指向私有仓，不写名字。

**唯一允许的写法**：占位符（`harness.example.com`）、环境变量（`{$DOMAIN}`、`REAL_SERVER`）、
角色化表述（「品牌渠道」「客户渠道」「同机第二栈」）。

**自检（改任何含渠道/域名/URL 的文件或写提交信息之前，先跑）**：

```bash
node scripts/check-no-real-domains.mjs          # 域名/主机名判据（白名单式，未登记即失败）
git log -1 --format=%B | grep -inE '<渠道名1>|<渠道名2>'   # 提交信息自查（渠道名清单见私有仓）
```

**为什么放在第 0 条**：这条一旦违反，泄露是不可逆的（公开仓的提交历史会被镜像与索引，
清理需要改写历史 + 强推 + 通知所有克隆）。代价 >> 任何功能收益，所以它是所有规则里唯一
"**先问再写**"的一条：**拿不准某个名字算不算渠道身份时，按"算"处理**。


This repository owns the desktop product around an unmodified DeepSeek Harness checkout.

## Prerequisites and setup

- Use Node.js `^22.19.0` or `>=24.0.0` and the root Yarn `4.18.0` release through Corepack.
- Initialize the pinned upstream checkout with `git submodule update --init --recursive`.
- Install root dependencies with `corepack yarn install --immutable`.

## Build, run, and verify

- Start the desktop development workflow with `corepack yarn dev`.
- Build the desktop package with `corepack yarn build`.
- Run unit tests with `corepack yarn test`.
- Run type checking with `corepack yarn typecheck`.
- Type-check the **root guard scripts** with `corepack yarn typecheck:scripts`（2026-10-25：`tsconfig.scripts.json` 用 `allowJs + checkJs` 把 `scripts/**` 的 `.mjs` **原样**纳入 TS 7 检查——不换扩展名、不加构建步骤；类型信息来自 JSDoc。基线 `strict: false` 全绿，`noUnusedLocals`/`noUnusedParameters` 已开（死代码进判据），`strictNullChecks`/`noImplicitAny` 是下一步棘轮；`scripts/wasm/probes/**` 是 Electron 渲染进程探针，不在面内。注意 TS 7 的 `strict` **缺省为 true**，所以配置里显式写 `false`）。它同时是**第 18 条根守卫** `check:scripts-types`（每次 `yarn check` 都跑），门禁化的入口是 `scripts/check-scripts-types.mjs`。
- Run the complete headless gate with `corepack yarn check`（2026-09-10 重构为 `scripts/check-workspaces.mjs`：**受构建依赖约束的并行编排**，不再是 10 个包串行 `&&`——阶段 1 跑 `dsh-plugin-desktop check` + **18 条根守卫**（唯一真源 = `node scripts/check-workspaces.mjs --list` 的 `guards:` 行；验收判据行的 `planned=35` = **17 个包 + 18 条守卫**，两条独立口径互相对上。2026-09-29 第三十轮 FIX-45 校正：此处曾写"三个根守卫"，与真值差 14 条），阶段 2 按依赖图调度其余包：`enterprise`/`connectors`/`cron` 的 tsc 依赖 desktop 的 `lib/types`，`account-card` 依赖 `enterprise`（其 tsdown `clean:true` 会清 `lib/`，并发读取会踩空 → 必须串行），`browser` 依赖 `connectors`，`capability-center`（能力中心 host + client 双面，2026-10-13 从 enterprise 拆出、同日 P0-b 把 host 面也搬入）依赖 `panel-surface`/`foot-menu`/`host-locale`/`host-home`/`gateway-client`，`gateway-client`（网关客户端叶子包）依赖 `host-locale`；依赖失败的包直接跳过并说明原因，不产生级联噪音。并发默认**机器自适应**（`scripts/build-capacity.mjs`：CPU 配额 + 可用内存 / 每任务内存单价；4 核 8GB 给 4，16 核 4GB 容器给 4，16 核 64GB 给 8），`CHECK_CONCURRENCY` 仍是覆盖口。`yarn check:fast` = 只跑本次改动影响的包（`git status`/`git diff` 映射到包，顶层文件改动自动升格为全量）。本地 `yarn check` 与 CI gate job 完全同义。`yarn prebuild` = `prebuildWorkspaceDeps` 一键构建全部 **15 个** workspace 包（唯一真源 = `packages/host/desktop/scripts/prebuild-workspace-deps.ts` 的 `WORKSPACE_PACKAGES` 表；2026-09-29 校正：此处曾写"8 个"），**已增量**（某包产物不早于其输入即跳过重建，`DSH_PREBUILD=force` 强制全量）+ **按依赖层并行**（2026-10-23：表是并行安全的唯一真源，按下表 `deps` 折层、同层并行，`PREBUILD_CONCURRENCY` 覆盖；判据在 `packages/host/desktop/tests/prebuild-dependency-table.spec.ts`）。门禁提速实测与设计见 docs/decisions/2026-09-10-verification-speedup.md）。
- Run the client E2E automation with `corepack yarn workspace dsh-plugin-desktop e2e:client` (see GUI E2E below; works against a packaged build and Xvfb, produces `.e2e-report.md` + `.e2e-shots/`). Real-service verification uses `e2e:real` (`REAL_SERVER/REAL_USER/REAL_PASS` env; produces `.real-env-report.md` + `.real-env-shots/`). Two focused behavioural probes cover surfaces `e2e:client` only asserts structurally, both against a packaged build + Xvfb + the same mock gateway: `e2e:sidebar`（官方右侧栏：展开/面板渲染/分栏/标题栏保留带，`.e2e-sidebar/`）与 `e2e:terminal`（0.1.6 新增的终端：点「新建终端」→ xterm 表面 → 真敲 `echo` 断言回显，`.e2e-terminal/`）。两者都不在 `yarn check` 内（需要打包产物与显示器），改动右栏/终端后手动跑。
- Run upstream operations through the root scripts, such as `corepack yarn upstream:build`.

## 编译与验证速度（性能口径，**AI 改代码前先读这一节**）

> 目标：**内循环的等待压到亚秒级，全量门禁留给提交前与 CI**。所有并行点的数字都从
> `scripts/build-capacity.mjs` 派生，**禁止再在任何地方写 `min(N, CPU)` 之类的字面量**
> （那正是"换台机器就变慢/OOM"的成因）。设计记录：
> `docs/decisions/2026-09-10-verification-speedup.md`（门禁）、
> `docs/decisions/2026-10-23-typescript-7-native.md`（编译器）、
> `docs/decisions/2026-10-23-build-speed-adaptive.md`（本轮：自适应并发 / 内循环 / 服务端）。

### 1) 机器自适应并发：唯一口径 `scripts/build-capacity.mjs`

- 探测：`availableParallelism()`（尊重亲和性）→ cgroup v2/v1 **CPU 配额**（容器里
  `nproc` 是宿主核数，配额才是真的）→ 可用内存（`/proc/meminfo` 的 `MemAvailable`，
  再被 cgroup `memory.max` 夹一次）。
- 折算：`并发 = min(CPU 预算 × 任务系数, 可用内存 / 该任务内存单价, 硬顶)`，永不为 0。
  内存单价表在模块里（`MEMORY_PER_TASK_MB`，带取值依据），**不要另抄一份**。
- 消费点（改这些地方的并发，只准从模块取）：`scripts/check-workspaces.mjs`（阶段 2 包并发
  + 按内存给子进程下发 `VITEST_MAX_WORKERS`）、
  `packages/host/desktop/scripts/prebuild-workspace-deps.ts`（同层包并发）、
  `packages/host/desktop/vitest.config.ts`（worker 数）、`server/Makefile`
  （`TEST_PARALLEL` / `GO_BUILD_P`）。
- 覆盖口（机器探测不准时的**唯一**逃生口）：
  `CHECK_CONCURRENCY` / `PREBUILD_CONCURRENCY` / `VITEST_MAX_WORKERS` / `TEST_PARALLEL` /
  `GO_BUILD_P` / `DSH_BUILD_CPUS` / `DSH_BUILD_MEMORY_MB` / `WEBADMIN_BUILD_CONCURRENCY`。
- 诊断：`node scripts/build-capacity.mjs --explain`（每个预算被谁限制）、`--json`；
  Makefile/shell 取单值：`node scripts/build-capacity.mjs --print goTestParallel`。
- 判据：`packages/host/desktop/tests/build-capacity.spec.ts`（10 条，含容器配额 / 内存受限 /
  env 覆盖 / 极小内存不为 0 的合成输入）。

### 2) 编译器：TypeScript 7 原生（`tsc`）

- 所有 workspace 包的 `typescript` = **7.0.2**（原生编译器）；`tsc -p …` 的**脚本写法不变**。
- 三个包（`dsh-plugin-desktop` / `@zeokeel/dsh-connectors` / `@zeokeel/dsh-enterprise`）另挂
  `typescript6: npm:typescript@6.0.3`：那 10 个守卫 spec 用 **TS6 编译器 API**
  （`createSourceFile` / `createProgram`），TS7 的 JS 包只剩版本号、且 `unstable/ast` **没有**
  从源码文本解析的入口 ⇒ 不要试图把它们"升级"到 TS7。
- **yarn bin 规则（最容易坏的一条）**：同一个包里两个依赖都提供 `tsc` 时，**yarn 脚本跑的是
  名为 `typescript` 的那个依赖**（别名只赢 `node_modules/.bin` 的链接）。所以形态必须是
  "`typescript`=7 + 别名叫 `typescript6`"，反过来会让脚本静默跑 6（慢 6–15×）而门禁全绿。
  判据：`packages/host/desktop/tests/typescript-compiler.spec.ts`（含 `yarn exec tsc --version`
  实跑抽样）。
- `server/webadmin`（独立 npm 工程）同样在 7：**TS7 移除了 `baseUrl`**，`paths` 改为相对
  tsconfig 目录解析。新增 webadmin 配置时不要在 `tsconfig.json` 写 `baseUrl`。

### 3) 内循环命令矩阵（**按改动面选命令，不要一律 `yarn check`**）

| 场景 | 命令 | 4 核实测 |
| --- | --- | --- |
| 改一行客户端 JS/TS | `yarn dev:watch`（tsdown 增量 + 应用自动重启） | 重建 **~0.3s** |
| 想快速起一个应用 | `yarn dev:fast`（brand-prepare + tsdown + 启动，不产 `lib/types`） | **~2s** |
| 需要 d.ts 给别的包用 | `yarn dev:watch --types`（附带 `tsc --watch`） | 构建 ~1s |
| 全量客户端构建（含 d.ts） | `yarn dev`（= 现在的 `build && node lib/bin.js`） | ~2.2s |
| 只跑一个包的门禁 | `node scripts/check-workspaces.mjs --only <pkg>` | 包级 ~5–20s |
| 只跑一组用例 | `yarn workspace <pkg> vitest run tests/x.spec.ts` | 秒级 |
| 改了哪些包就只跑哪些 | `yarn check:fast`（git 改动映射到包） | 视改动 |
| **提交前 / PR** | `yarn check`（全量 35 任务） | **~300s** |
| 服务端快速门禁 | `make check-fast`（gofmt + vet + 缓存命中的 go test + webadmin 单测） | 分钟级 |
| 服务端单包/单用例 | `cd server && go test ./internal/<pkg>/... -run <Name> -count=1` | 秒级 |
| 服务端编译 | `cd server && go build ./cmd/server`（热缓存 1.4s / 冷缓存 41s） | 见左 |
| **服务端全量门禁** | `make check`（含 webadmin 变体矩阵 ≈6min） | 分钟级 |
| 打包 | `yarn dist:linux` / `package:dir` | **分钟级** |

**纪律**：`yarn check` / `make check` / `dist:*` / `e2e:*` **不进内循环**（它们是分钟级，
留给提交前、PR 与 CI）。`yarn check` 里编译只占 ~1/10，真正的大头是 vitest 与 8 个 verify 脚本。

### 4) 服务端（`server/`）

- `TEST_PARALLEL` / `GO_BUILD_P` 缺省由 `scripts/build-capacity.mjs` 算（旧值写死 4：
  16 核机器浪费 3/4 的核、4GB 容器照开 4 路）。**调高 `TEST_PARALLEL` 时必须同时调大
  `TEST_TIMEOUT_PARALLEL`**（它的取值依据是 `-p 4` 的实测膨胀，见 Makefile 长注释）。
- Go 缓存是冷热两重天：冷 `GOCACHE` 41s、热 1.4s（`cmd/server`）。CI 与本地都别清缓存；
  离线/受限环境用仓库已 gitignore 的 `server/temp/gocache`（`GOCACHE=...`）。
- DB 用例走**模板库克隆**（每用例 ~0.1s，见 `internal/serverstore/dbtest.go`）：`PG_DSN_TEST`
  保持同一套 env 才能命中 `go test` 结果缓存；`-count=1` 只在门禁用（`make test-server`），
  内循环用 `make test-server-fast`。
- `make check` 里的 webadmin 变体矩阵（4 × 单测）与产物判据（5 × vite build）是**分钟级**的
  发布判据，不在 `check-fast` 内——不要为了让内循环"看起来绿"去动它们的覆盖面。

## CI (2026-09-06 重设计，见 docs/decisions/2026-09-06-ci-pipeline-redesign.md)

- 触发 = `pull_request` + `push`（全分支含 tag）。**非 docs-only 的提交都产出可下载产物**（Artifacts）：`desktop-Linux`（AppImage；`dist:linux` 会一并构建 `deb`，但归集面只收 AppImage —— 镜像与发布面都不要 deb）、`desktop-Windows-installer`（NSIS）、`desktop-macOS`（DMG）、`zeokeel-server-linux-amd64`（R28 审计 AB2-A-05 校正：只改 `docs/`、`site/`、`*.md` 的提交由 `changes` job 判成 docs-only，`gate`/`server`/三平台 job 全部跳过 ⇒ **零 artifact**，只有 `gate-guards` 照跑；**2026-10-10 起分支首推也走这条轻量路径** —— `before` 是全零时改用 `merge-base(origin/master, HEAD)` 作基点，覆盖整条分支相对主线的改动，取不到才 fail-safe 成"有代码改动"）；PR 由 `pr-summary` job 评论汇总入口（fork PR 跳过；评论正文按 `needs.*.result` 派生，未全绿时不列不存在的产物）。
- **测试只在 PR / master push 上跑，tag 只编译 + 打包 + 发布（2026-10-10 拍板）**：tag 上的 `gate` 跳过 `yarn check` 与 WASM 探针、`server` 跳过 gofmt / `go vet` / `go test` / webadmin `npm test`（保留构建与 `make build-server`），五个发布正确性判据（release-policy / 发布说明 / 迁移锚点 / 拓扑 / 渠道 pin）照旧。依据：tag 永远打在已跑过全量 CI 的线上提交上，重跑一遍只是把发布再拉长 ~20 分钟。这条"允许跳过"的形态**登记**在 `scripts/check-workflows.mjs` 的 `PINNED_STEP_IF_POLICIES['docs-only-and-not-tag']`（未登记的任何收窄一律拒）。
- **镜像分发（2026-09-10 起）**：不经任何镜像仓库（GHCR 已下线，`docker.yml`/`ghcr-cleanup.yml` 已删）。tag 时 `release` job 从源码构建镜像（打进三平台客户端资产 + 私有渠道仓的渠道内容）→ `docker save | zip` 成 `zeokeel-server-<v>-amd64.zip` → **同一个 job 内**先上传更新服务器 R2（`scripts/ci-publish-update-server.sh`，写 `release.zeokeel.com/<channel>/releases/<v>/` 并清理到最近 2 个版本（最新版 + 上一个版本）；`publish-update-server` 是 job 里的**一步**，不是独立 job）→ 再挂 GitHub Release（**只对 beta/official**，品牌渠道不公开）。客户侧只从 R2 自己的渠道目录取镜像。上传后对**三个对象**（镜像 zip、`SHA256SUMS`、`latest.json` 指针）逐个做"大小 + SHA256"完整性对拍，任一不符即失败且不写指针；判据在 `scripts/verify-ci-scripts.mjs`（假 aws 支持按对象名注入故障）。
- job 结构：`changes`（docs-only 分类器）→ `gate-guards`（**永不跳过**的根守卫 job：docs-only 的 PR 也跑 `scripts/check-root-guards.mjs`）∥ `gate`（ubuntu：`yarn check` 全量门禁 + 一次构建，上传 `workspace-build` = 15 包 `lib/**` + desktop `build/**`；tag 上还跑 tag 形态 / 基线拓扑 / 渠道仓 pin 三条判据与策展说明检查）→ `server`（并行：PG 18 容器 + gofmt + go vet + `go test -p 4 -timeout 25m` + webadmin `npm test` + `make build-server`，job 预算 75 min，算式见 ci.yml 那一段注释）∥ `webadmin-variants`（2026-10-23 从 server 拆出、与 go test 并行：4 个非缺省变体单测 + 5 次 vite 产物判据，≈7–8 min，job 预算 30 min）→ `desktop-linux/win/macos`（`needs: gate`，下载 `workspace-build` 恢复后**只做打包 + 平台验证**，其中 linux 追加 `e2e:client`）→ tag 时 `release`（needs `gate` + 三个 desktop job：构建各渠道镜像 → 导出 zip → 上传 R2 → `gh release create`）。
- **发布面硬规则（2026-09-11 定案，2026-09-23 更新口径）**：Release **名 = tag 本身**（`ZeoKeel Harness v…` 前缀会被 Releases 页左侧列表截断成 `…v2.6…`，同页版本号全不可见）；**正式 tag 与预发 tag 都必须**有策展发布说明 `docs/releases/<tag>.md` —— 三道同口径的检查（`gate` 第一步 / `release` job 首步 / `gh release create` 之前），缺失即失败，**`--generate-notes` 回退已删除**（自动变更日志的正文来自提交信息与 PR 标题/正文，那两处不在 `check-no-real-domains` 的判据面内，历史上正是这条路径把真实域名/IP 带进了公开 Release 正文）。模板与写作口径 `docs/releases/TEMPLATE.md`。tag 发布链另有三条判据：tag 形态唯一真源 `scripts/ci-release-policy.sh`（未知后缀当场红）、基线拓扑 `scripts/ci-release-topology.sh`（上一个 tag 不在主线即红）、渠道仓检出 pin（`gate` 解析一次 `channels_rev`，四个调用点以 `CI_CHANNELS_PIN` 复用并硬校验）。
- 打包脚本开关（消除重复编译）：`--no-prebuild`（跳过 `prebuildWorkspaceDeps` 15 包构建）、`--no-gates`（跳过入口内嵌 check：win `check:win-package` / mac smoke 根 check / mac release pack 内根 check）。默认（本地 `yarn dist:*`）= prebuild + 内嵌 check + 打包 + 验证，行为不变。打包后的平台验证（`verify-win-installer` / `verify-mac-smoke` / `verify-mac-release` / `afterPack`）**不在跳过范围**。
- `check:win-package` 是「构建后」平台检查（不含 build；产物由 prebuild 或 CI gate 提供）。

- `deepseek-harness/` is a pinned upstream Git submodule. Never edit files inside it from a desktop feature branch.
- The outer repository is product-owned and independent of the former `anywhere-labs/dsh-desktop` (previously `anywhere-labs/deepseek-harness-desktop`) upstream: no `upstream` remote exists and no whole-tree merges are performed. Valuable upstream fixes are cherry-picked by commit when needed. Only the `deepseek-harness/` submodule pin is followed as an upstream sync.
- `packages/host/desktop/` owns the Cordis Host and Client faces, Electron bootstrap, packaging, and release tests.
- On the enterprise feature branch, feature work must only edit `packages/host/enterprise/` and `server/`. No changes to other service packages or to `deepseek-harness/`; test adaptations in desktop-owned scripts are allowed. Product branding (productName, icons, window/notification copy) is desktop-owned and may be touched for brand changes, injected through profile composition config where possible.
- **Server API contract (see `server/AGENTS.md` §7 for details):** all Go API endpoints must return JSON (`application/json`; success via `c.JSON`, failure via the `{"error":{"code","message"}}` envelope through `serverauth.WriteError` — never `c.HTML`/`c.String`/body-less responses). API routes are declared centrally in `server/internal/router` (`/api/server/*` for the admin/management surface, `/api/client/v2/*` for the client/employee surface); legacy prefixes (`/api/*`, `/v1/*`, `/v2/api/*`, `/v2/v1/*`) are removed — do not add them back. Client (enterprise) calls `/api/client/v2/*`; webadmin calls `/api/server/admin/*` and public `/api/client/v2/channel`; keep both ends in sync when adding/changing endpoints.
- **Brand mark assets are a single authority: the `brands/official/` folder** (channel-scoped folders live at `brands/<channel-id>/`). 2026-09-10 起**对外文案与渠道差异不再来自代码或 webadmin，而来自私有仓 `zeokeel/channels` 的渠道配置**（`channels/<channel-id>/channel.json`：名称/标语/欢迎语/主题色 + logo 素材；构建时注入镜像）。`brands/official/logo.svg` 仍是**几何真源**：渠道目录里的 logo 必须由它派生（CI 复制），本文件下述几何规则对所有渠道同样适用。 Every logo or brand mark in any form (app/tray/window icons, favicons, sidebar/hero/chat brand marks, login page art, admin console art, site/branding assets, docs, OG/social images, and any fallback/placeholder artwork) **must be derived from `brands/official/logo.svg` — never invented, never hand-drawn, never a text glyph** (no `P` letters, no custom shapes, no third-party marks such as the upstream DeepSeek fish).
  - `brands/official/logo.svg` = **white rounded square** (1254×1254, corner radius 180, fill `#FFFFFF`) carrying the **full-color gradient wave mark**: one circle + six paths filled by six `linearGradient` defs (`id0`–`id5`), drawn inside `transform="translate(627 627) scale(0.10709006) translate(-5943.7880 -4987.8288)"` (mark at 78% content, centered). This transform and the gradient fills are part of the approved design — keep them in every derived SVG inline or file; never flatten the mark to `currentColor`/a single fill except for the macOS tray template (alpha only, black+clear).
  - The pair is **mandatory day/night**: `brands/official/logo-dark.svg` uses the **same mark geometry and same mark colors** and only changes the tile fill to `#000000`; light/daily surfaces use `logo.svg`, dark/night surfaces use `logo-dark.svg` — never invent a third chromatic variant and never invert the mark colors. Fallback marks on client surfaces (sidebar/login) use the **transparent mark-only SVG** derived by removing the tile `<rect>` from `logo.svg`; the server portal and favicons use the **full colorful tile variants** (`logo.svg` for light, `logo-dark.svg` for dark) — never a monochrome/currentColor fallback on those surfaces.
  - All other visuals (colors, accents, gradient) must not redesign the mark. When a surface cannot use the SVG (e.g. PNG bitmaps), derive it from the brand folder (sharp renders from the same source; see `packages/host/desktop/scripts/generate-tray-icons.mjs` and `packages/host/desktop/scripts/brand-prepare.mjs`) and never rasterize a different drawing.
  - Before adding any logo asset or brand mark: resolve `git diff` and confirm it traces to `brands/official/logo.svg`; if a surface cannot, it should keep the previous official mark rather than a placeholder. Do not copy logo geometry from memory, from upstream packages, or from historical versions (the old version was a text `P` on a tile; it is retired and must not reappear anywhere, including fallbacks).
- **Real customer / deployment domains and hostnames must never appear in this repository**（客户自有域名、被投递/测试环境的真实主机名；示例写法一律用保留命名空间 `*.example.com`）。本仓**公开**（GitHub `zeokeel/ZeoKeel-Harness`），真实域名会同时暴露客户身份与其基础设施命名。
  - 禁止位置：文档与设计/规划稿（含代码块、JSON 示例、`server_url` 字段、部署示例）、测试夹具与断言、脚本默认值、注释。
  - 允许写法：占位符域名（`harness.example.com`）、环境变量（`{$DOMAIN}`、`REAL_SERVER`）。脚本若需默认值，留空或指向 `example.com`，让调用方必须显式传入。
  - 渠道/客户身份属于**私有仓** `zeokeel/channels`；本仓只保留占位符。真实域名只允许出现在部署机上的 `.env` 与运维脚本，不进版本库。
  - 自检口径：改动含域名/URL 的文件后跑 `node scripts/check-no-real-domains.mjs`（白名单式前向守卫：URL host / 裸主机名 / 提交信息三个判据，未登记的 host 一律失败）必须为空；**提交信息同样适用**（提交信息也是公开的）。
- `community/fabric/` owns the community interoperability RFC. Until schemas and a reviewed reference adapter exist, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
- The outer repository and all owned packages use the root Yarn release with `nodeLinker: node-modules`.
- The upstream submodule keeps its own pnpm workspace. Run upstream commands through the root `upstream:*` scripts, whose Yarn portable-shell commands enter the submodule before invoking Corepack.
- Compatibility mode must run the upstream default client without overrides. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep the submodule pin update separate from desktop behavior changes.
- Keep the repository topology and package-manager split consistent with the [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).
- GUI end-to-end testing on a headless box: use the formal client E2E tool — `corepack yarn workspace dsh-plugin-desktop e2e:client` (`packages/host/desktop/scripts/e2e-client.mjs`). It brings up a mock gateway (`e2e-fixture-gateway.mjs`, port 34567 — real route table, verified 2026-09-08: `/api/client/v2/auth/login|methods|me|usage`, `/api/client/v2/config/bootstrap`, `/api/client/v2/agent-presets`, `/api/client/v2/shared-skills`, any `/api/*skill*`, `/api/workspaces|workspace|zeokeel/workspaces`, `/api/sessions*`|`/api/conversations`, `/api/cron|jobs`, `/api/admin*|zeokeel*`, other `/api/*` → `{ok:true}` fallback; there is no `/api/tasks` or `/api/models` branch), launches the packaged app against Xvfb `:99` with a writable `HOME` (`HOME=/tmp/... XDG_CONFIG_HOME=... DSH_HOME=...` — `/root/.config` is read-only in the sandbox and this app ignores `--user-data-dir`, so the singleton lock fails unless HOME is redirected), drives it over CDP on `--remote-debugging-port=9223`, asserts every client surface (login, sidebar nav, connectors, skills, settings, official automation panel, chat input, advanced mode, workspace picker, account page), captures screenshots to `packages/host/desktop/.e2e-shots/`, and writes `packages/host/desktop/.e2e-report.md` (**断言条数不在这里写死**：唯一真源是该报告首行的「结果：N/N 通过」—— `reportStep(` 调用点里 7 个在 `for (const item of pagePanels)`（3 项）循环里，运行期条数 ≠ 调用点数 ≠ 字面量出现次数；含「错误监控链路真实激活（客户端 → GlitchTip 兼容摄取端点）」—— 断言 mock 网关的 Sentry 摄取账本计数严格大于登录前基线，`error_reporting_enabled` 关掉即红 —— 与「渲染进程未捕获错误真实进链路」—— 在页面主世界真抛一个未捕获错误，断言摄取账本里出现带 `zeokeel.process=renderer` tag 且消息含本次一次性 marker 的事件（监听装错世界即红）；非零 exit on failure, CI-able). It reuses an already-running CDP app instead of spawning a second instance. **Packaged builds stop debug-class switches in two layers, and the split matters.** The JavaScript gate (`packages/host/desktop/src/debug-switches.ts` plus the module-scope refusal in `src/main.ts`) covers `--remote-debugging-port|pipe` and `--js-flags`, in single- and double-dash form — the CDP forms hand local processes the HttpOnly `dsh-auth-*` cookie. It structurally cannot cover the `--inspect*` family: `--inspect-brk` suspends V8 before the app's main script runs at all, and `--inspect` leaves a window before the (asynchronous) ESM graph reaches the gate — on a real packaged build both handed local processes main-process RCE (`execSync('id -un')` → `root`) ahead of the refusal. That family is instead dropped at argv-parse time by the Electron fuse `EnableNodeCliInspectArguments=false`, flipped in the `afterPack` hook (`packages/host/desktop/scripts/verify-packaged-runtime.ts`) right before signing; it leaves `--remote-debugging-port|pipe`, `--js-flags` and development (`yarn dev`, unpackaged) builds untouched, and has no environment escape hatch. **Do not read that gate as a closed debug surface**: it covers an explicit list of names (`DEBUG_SWITCHES` in `packages/host/desktop/src/debug-switches.ts` — the Node inspect family including the hidden alias `--inspect-brk-node`, which upstream registers as `addReadOnlyProcessAlias('_breakNodeFirstLine', '--inspect-brk-node', false)` and never lists in `--help`, plus the Chromium CDP forms), so Node/Chromium aliases **outside that list are not in it** and the whole `--inspect*` family is backstopped by the packaging-time fuse rather than by JS. On top of that, the gate's `ZEOKEEL_ALLOW_DEBUG_SWITCHES=1` escape hatch (set by the six launchers under `packages/host/desktop/scripts/` and `integration-tests/electron-shots/`, which drive a **packaged** build over CDP) is an automation affordance rather than a boundary — in the same-machine-same-user threat model the attacker controls argv and environment alike. Without that variable the app exits 1 before exposing CDP and the script fails with 「app did not expose CDP within 30s」. Manual CDP driving is still possible: `fetch('http://127.0.0.1:9223/json/list')` for the page target, WebSocket `Runtime.evaluate`. Kill app processes with `pkill -9 -f "dist/linux-unpacked/[d]sh-plugin-desktop"` (bracket trick — plain `pkill -f electron` matches the invoking shell and hangs it).
