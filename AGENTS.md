# AGENTS.md — ZeoKeel Harness

本文件是**给 coding agent 与人类开发者共用**的操作手册。格式遵循 AGENTS.md 约定：
先给可执行命令与硬规则，再给理由；长文下沉到 `docs/agent/`。

- 嵌套规则：`server/AGENTS.md`（Go 服务端）就近优先；
- 展开说明：`docs/agent/README.md`（环境/工具链/工作流/架构/测试/发布）；
- 历史决策：`docs/decisions/`；审计与事故：`docs/AUDIT-*`、`docs/playbooks/`。

---

## 0. 铁律 0：渠道与客户身份**永不进本仓**（唯一"先问再写"的规则）

**本仓是公开仓**（GitHub `zeokeel/ZeoKeel-Harness`）。渠道 / 客户身份属**私有仓** `zeokeel/channels`，
本仓只保留占位符。

**禁止出现**（任何位置、任何形态）：

- 渠道 id、渠道显示名 / 短名 / 产品名、客户或 OEM 品牌名（含中英文写法、拼音、缩写）；
- 客户自有或被投递环境的**真实域名、主机名、IP、目录名、容器名、镜像 tag、`.env` 取值**；
- 上面的名字出现在**示例、夹具、断言、注释、脚本默认值、文档正文、表格、代码块、URL** 里。

**同样适用于 git 提交信息（subject 与 body）与 GitHub PR / Release 文案** —— 提交信息是公开且
可检索的，泄露面与文件正文完全相同。写提交信息用中性表述：「某客户渠道」「第二个渠道栈」
「渠道 A」；需要具体身份时指向私有仓，不写名字。

**唯一允许的写法**：占位符（`harness.example.com`）、环境变量（`{$DOMAIN}`、`REAL_SERVER`）、
角色化表述（「品牌渠道」「客户渠道」「同机第二栈」）。

**自检（改任何含渠道/域名/URL 的文件或写提交信息之前）**：

```bash
node scripts/check-no-real-domains.mjs          # 白名单式前向守卫，未登记 host 一律失败
git log -1 --format=%B | grep -inE '<渠道名1>|<渠道名2>'   # 渠道名清单见私有仓
```

**为什么是第 0 条**：这条一旦违反，泄露不可逆（公开仓历史会被镜像与索引，清理需改写历史 +
强推 + 通知所有克隆）。代价远大于任何功能收益，所以它是唯一"拿不准时按算处理"的规则。

---

## 1. 这个仓库是什么（30 秒）

- 外层仓拥有**桌面产品**：围绕一个**未修改的上游 DeepSeek Harness checkout**（`deepseek-harness/`
  是 pinned Git 子模块；永不编辑）。
- 拓扑：`packages/<scope>/<pkg>/` = 16 个 workspace 包 + `community/fabric`（共 17 个），
  `server/` = Go 服务端（含独立 `server/webadmin` npm 工程），`site/` = 官网，`brands/` = 品牌资源。
- 门禁：**20 条根守卫 + 17 个包的 check = 37 个任务**（唯一真源：
  `node scripts/check-workspaces.mjs --list`）。
- 本仓**没有 `upstream` remote**，也从不整树合并上游；只跟随 `deepseek-harness/` 的 pin。

**关键不变量（改代码前先确认没破）**：

- `packages/host/desktop/` 拥有 Cordis Host/Client 面、Electron 引导、打包与发布测试；
- 品牌几何唯一真源是 `brands/official/logo.svg`，所有图标/标识必须由它派生（白天/夜间两版）；
- Go API 路由集中声明在 `server/internal/router`：管理面 `/api/server/*`、客户端面
  `/api/client/v2/*`；旧前缀（`/api/*`、`/v1/*`、`/v2/api/*`、`/v2/v1/*`）已删，**不得加回**。

---

## 2. 环境（开工前先过这一节）

必需版本（机器真源：根 `package.json` 的 `engines`/`packageManager` 与 `server/go.mod`）：

| 工具 | 版本 | 验证 |
| --- | --- | --- |
| Node.js | `^22.19.0` 或 `>=24.0.0` | `node -v` |
| Corepack + Yarn | `yarn@4.18.0` | `corepack yarn --version` |
| Git + 子模块 | `deepseek-harness/` pin | `git submodule status deepseek-harness` |
| Go | `1.26.6`（改 `server/` 时） | `cd server && go version` |

```bash
git submodule update --init --recursive
corepack enable
corepack yarn install --immutable
make -f Makefile.agent doctor        # 缺必备项会 exit 1
```

架构工具（按需，已入库的版本）：`dependency-cruiser@18.7.0`（根 devDependency）、
`@swc/core@1.16.20`（TS 解析器）、`go-arch-lint@v1.19.0`（Go，二进制不入库）。
安装/验证/边界见 `docs/agent/toolchain.md`。

**不要**：混用 `npm install`（nodeLinker 是 `node-modules`）；在坏环境（子模块未 init、
依赖未装）上写代码；把工具装到全局后假设别人也有。

---

## 3. 内循环命令（按改动面选，**不要一律 `yarn check`**）

| 场景 | 命令 | 参考耗时 |
| --- | --- | --- |
| 改一行客户端 TS/TSX | `corepack yarn dev:watch` | 重建 ~0.3s |
| 快速起应用 | `corepack yarn dev:fast` | ~2s |
| 需要 d.ts 给别的包用 | `corepack yarn dev:watch --types` | 构建 ~1s |
| 只跑一个包的门禁 | `node scripts/check-workspaces.mjs --only <pkg>` | 5–20s |
| 只跑一组用例 | `corepack yarn workspace <pkg> vitest run tests/x.spec.ts` | 秒级 |
| 改了哪些包就只跑哪些 | `corepack yarn check:fast` | 视改动 |
| 提交前 / PR | `corepack yarn check` | ~300s |
| 服务端快速门禁 | `cd server && make check-fast` | 分钟级 |
| 服务端单包/单用例 | `cd server && go test ./internal/<pkg>/... -run <Name> -count=1` | 秒级 |
| 服务端编译 | `cd server && go build ./cmd/server` | 热缓存 1.4s |
| 架构（TS） | `make -f Makefile.agent arch-ts` | 秒级 |

**纪律**：`yarn check` / `make check` / `dist:*` / `e2e:*` **不进内循环**（分钟级，留给提交前与 CI）。

**构建入口**：`corepack yarn prebuild` 一键构建全部 **15 个** workspace 包（唯一真源 =
`packages/host/desktop/scripts/prebuild-workspace-deps.ts` 的 `WORKSPACE_PACKAGES` 表；
已增量：某包产物不早于其输入即跳过，`DSH_PREBUILD=force` 强制全量；按依赖层并行，
`PREBUILD_CONCURRENCY` 覆盖）。

**并发口径**：所有并行度来自 `scripts/build-capacity.mjs`（CPU 配额 + 可用内存折算），
**禁止**再写 `min(N, CPU)` 之类字面量。覆盖口：`CHECK_CONCURRENCY` / `PREBUILD_CONCURRENCY` /
`VITEST_MAX_WORKERS` / `TEST_PARALLEL` / `GO_BUILD_P` / `DSH_BUILD_CPUS` / `DSH_BUILD_MEMORY_MB`。

**TypeScript 7 的三条硬规则**：

1. 所有 workspace 包 `typescript` = `7.0.2`（原生编译器），`tsc -p …` 脚本写法不变；
2. `dsh-plugin-desktop` / `@zeokeel/dsh-connectors` / `@zeokeel/dsh-enterprise` 另挂
   `typescript6: npm:typescript@6.0.3`（那 10 个守卫 spec 用 TS6 编译器 API）；
3. **yarn bin 规则**：同包两个依赖都提供 `tsc` 时，脚本跑的是名为 `typescript` 的那个；
   形态必须是 "`typescript`=7 + 别名 `typescript6`"，反过来会让脚本静默跑 6（慢 6–15×）。
   判据：`packages/host/desktop/tests/typescript-compiler.spec.ts`。

---

## 4. 验证与门禁

- `corepack yarn check` = 阶段 1（desktop check + **20 条根守卫**）→ 阶段 2（按依赖图调度其余包）。
  本地与 CI gate job 完全同义。
- `corepack yarn check:fast` = 只跑改动影响的包（`git status`/`git diff` 映射；顶层文件改动升格全量）。
- 只跑单包：`node scripts/check-workspaces.mjs --only <pkg>`；列表：`--list`。
- 根脚本类型面：`corepack yarn typecheck:scripts`（= 第 18 条守卫 `check:scripts-types`；
  `tsconfig.scripts.json` 用 `allowJs + checkJs`，基线 `strict:false`，`strictNullChecks`/
  `noImplicitAny` 是下一步棘轮；**不得用 `@ts-nocheck` 绕过**）。
- **改判据 = 改结论**：守卫脚本有内容摘要（`check-root-guards.mjs` 的
  `REGISTERED_GUARD_ENTRIES`）+ 独立第二判据（`verify-check-workspaces.mjs`）。新增/修改守卫必须
  同时更新登记与摘要（`node scripts/check-guard-parser-integrity.mjs --print-digests`），
  且**单独提交、单独评审**；`advisory` 是登记制豁免，未登记即 fail-loud。
- **验收前置**：修 P0/P1、改跨包契约、改判据，先在 `changes/` 写记录（模板
  `changes/README.md`），`acceptance` 必须是"跑什么命令、看到什么输出算通过"。
  `changes/*.json` 的字段契约已门禁化（第 20 条根守卫 `check:change-intent`：坏 JSON /
  未知 status / accepted 起缺 `acceptance` / verified 起缺 `verification` 一律拦门禁）。
- 架构判据：`make -f Makefile.agent arch-ts`（规则与基线见 `docs/agent/architecture.md`），
  同一组参数也是第 19 条根守卫 `check:architecture`（`yarn check` 每次真的跑；
  手动入口只是内循环便利）。基线只能缩不能放；新增违规必须修。
- 服务端：`cd server && make check-fast`（内循环）/ `make check`（全量，含 webadmin 变体矩阵）。
  `-count=1` 只用于门禁；DB 用例走模板库克隆，保持同一套 `PG_DSN_TEST` 才能命中缓存。
- 测试/探针细节（E2E、真服务、变异自证、反假绿清单）见 `docs/agent/testing.md`。

---

## 5. 架构与所有权（硬约束）

分层（已由 dependency-cruiser 判定，例外见基线）：

```
packages/host/desktop   ← 唯一顶层装配者
packages/host/*         ← host 面能力包
packages/client/*       ← 渲染进程 UI 包（允许依赖 host）
packages/vendor/*       ← 叶子
community/fabric        ← 文档脚手架，不得声明可加载入口
```

- 包内 `src/host/**`（主进程）与 `src/client/**`（渲染进程）**互不引用**；跨面只走 Cordis
  服务/事件、已声明子路径导出、或本机回环 HTTP。
- `host` 包（除 desktop）**不得反向依赖** `packages/host/desktop/`（`tests/` 例外）。
- `community/fabric/` 在 schemas 与参考适配器评审前只是私有文档脚手架，**不得声明 DSH/包入口**。
- **企业特性分支**只改 `packages/host/enterprise/` 与 `server/`；不改其他服务包、
  不改 `deepseek-harness/`（desktop 拥有的测试适配脚本除外）。品牌变更走 profile 组合配置。
- `deepseek-harness/` 是上游子模块：**永不编辑**；升级只动 pin，且 pin 更新与桌面行为改动**分开提交**。
- Go 侧已启用：`server/.go-arch-lint.yml` 是**基线即配置**（生产 import 图 DAG；`*_test.go`
  被 `excludeFiles` 排除）；新增一条跨包 import 必须改配置并评审，删边=收紧。

---

## 6. 代码风格与类型

- TS 包统一开启 `strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、
  `noImplicitOverride`、`verbatimModuleSyntax`；新增代码不得用 `any` 逃逸（必要时 `unknown` + 收窄）。
- 根 `scripts/**` 是 `.mjs` + JSDoc：`allowJs + checkJs`，`noUnusedLocals`/`noUnusedParameters`
  已开（死代码进判据）。
- 命名与文件形态跟随同目录既有约定；注释写**为什么**（事故/判据来源），不复述代码。
- Go：`gofmt` + `go vet` 必须过；API 一律 JSON（成功 `c.JSON`，失败
  `{"error":{"code","message"}}` 经 `serverauth.WriteError`），禁止 `c.HTML`/`c.String`/无 body。
- 客户端文案/主题走既有 locales 与主题 token，不硬编码颜色/字符串。

---

## 7. 安全与隐私

- 真实域名/主机名/IP/凭据**永不进仓库**（见铁律 0）。
- 打包构建的调试开关分两层：JS 门覆盖 `--remote-debugging-port|pipe`、`--js-flags`；
  `--inspect*` 家族由打包期 Electron fuse `EnableNodeCliInspectArguments=false` 在 argv 解析期丢弃。
  `ZEOKEEL_ALLOW_DEBUG_SWITCHES=1` 是自动化放行，**不是安全边界**。
- E2E 在无头机跑时重定向 `HOME`（`/root/.config` 只读会让 singleton lock 失败）；
  杀应用进程用 `pkill -9 -f "dist/linux-unpacked/[d]sh-plugin-desktop"`。
- 真实服务凭据只从环境变量（`REAL_SERVER`/`REAL_USER`/`REAL_PASS`）来，不落盘。

---

## 8. CI 与发布（要点，细节见 `docs/agent/release.md`）

- 非 docs-only 提交产出 Artifacts：`desktop-Linux`（AppImage；deb 不归集）、
  `desktop-Windows-installer`、`desktop-macOS`、`zeokeel-server-linux-amd64`；
  docs-only 由 `changes` job 判定并跳过 `gate`/`server`/打包，但 `gate-guards` **永不跳过**。
- 测试只在 PR / master push 跑；tag 只编译+打包+发布（tag 永远打在已跑过全量 CI 的提交上）。
  tag 上允许跳过的步骤登记在 `scripts/check-workflows.mjs` 的
  `PINNED_STEP_IF_POLICIES['docs-only-and-not-tag']`；**未登记的任何收窄一律拒**。
- Release 名 = tag 本身；正式与预发 tag 都**必须**有 `docs/releases/<tag>.md`（缺失即失败；
  已删除 `--generate-notes` 回退）。镜像不经镜像仓库：tag 时构建 → `docker save | zip` →
  上传更新服务器 R2 → 挂 GitHub Release（beta/official）。上传后对三个对象做大小+SHA256 对拍。
- 改 `.github/workflows/**`、`scripts/**`、`patches/**`、`yarn.lock` 会被
  `check:workflows` / `check:install-integrity` / `verify-layout` 等判据约束；
  **不要为了"让门禁绿"去动判据或跳过步骤**。

---

## 9. PR 与提交

- **线性历史**：master 只接受 squash/rebase（不允许 merge commit）。
- 大方向变更前先提交；子模块 pin 更新与行为改动分开。
- 每个 bugfix 应带**会先失败的回归用例**；每个 P0/P1 关闭应在 `changes/` 留记录并写明验证命令。
- 提交信息与 PR 文案是公开面：不写渠道/客户身份、不写真实域名。
- 不提交构建产物（`lib/`、`dist/`、`build/` 派生件、`.e2e-*` 报告）与本地缓存（`temp/`）。

---

## 10. 目录索引

| 路径 | 内容 |
| --- | --- |
| `docs/agent/` | 环境与工具链、工作流、架构规则、测试、发布 |
| `docs/decisions/` | 长期约束与取舍（按日期） |
| `docs/planning/` | 方案与路线（含 SI 自我改进清单） |
| `docs/playbooks/` | 多子代理回归审计话术 |
| `docs/AUDIT-*` | 历轮审计与事故复盘 |
| `changes/` | 变更记录（意图 + 验收 + 验证） |
| `.agents/notes/` | 已实现的进程/架构决策笔记 |
| `server/AGENTS.md` | Go 服务端规则（就近优先） |
| `scripts/` | 根守卫与门禁编排（改判据前先读 `check-workspaces.mjs` 头注释） |
