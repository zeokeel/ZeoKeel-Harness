# 2026-10-23 编译 / 门禁速度：机器自适应并发 + 内循环 + 服务端

## 背景

前端（15 个 workspace 包 + Electron 桌面）与服务端（Go + webadmin）的"编译等待"此前是按
**两台机器**的实测各拍各的数，导致：

- 16 核机器上 `yarn check` 仍只开 **4** 路包并发（`min(4, CPU)`），3/4 的核闲着；
- 4GB 容器里同样开 4 路 + 每包 vitest 不限 worker ⇒ 容易进 swap/OOM；
- `prebuildWorkspaceDeps` **串行**跑 15 个包（4 核实测 39s，大部分时间只有 1 个核在动）；
- 服务端 `TEST_PARALLEL ?= 4` 写死；`go build` 没有 `-p`；
- 开发内循环每次 `yarn dev` 都要走全量 `build`（clean + brand-prepare + tsdown + 2×tsc），
  改一行也要付一遍（TS7 之后 2.2s，TS7 之前 8.5s），而 `tsdown --watch` 的增量重建实测 ~300ms。

本轮把这四条收口成"**一个口径、四个消费点、可覆盖、有判据**"，并把"内循环该跑什么命令"
写进 `AGENTS.md`（其他 AI 直接照做）。

## 改造

### 1) 机器容量探测 = 唯一口径（`scripts/build-capacity.mjs`）

- 探测：`availableParallelism()`（尊重亲和性）→ **cgroup v2/v1 CPU 配额**（容器里 `nproc`
  是宿主核数，配额才是真的）→ 可用内存 = `min(/proc/meminfo 的 MemAvailable, cgroup
  memory.max, 物理总量)`。
- 折算：`并发 = min(CPU 预算 × 任务系数, 可用内存 / 该任务内存单价, 硬顶)`，永不为 0。
  内存单价表（`MEMORY_PER_TASK_MB`）在模块里，**带取值依据**（tsc 6 峰值 / vitest worker /
  go test 单包 / go build 单包 / vite build）。
- 覆盖口：`CHECK_CONCURRENCY` / `PREBUILD_CONCURRENCY` / `VITEST_MAX_WORKERS` /
  `TEST_PARALLEL` / `GO_BUILD_P` / `DSH_BUILD_CPUS` / `DSH_BUILD_MEMORY_MB` /
  `WEBADMIN_BUILD_CONCURRENCY`。
- 诊断：`node scripts/build-capacity.mjs --explain`、`--json`、`--print <key>`。
- 判据：`packages/host/desktop/tests/build-capacity.spec.ts`（10 条合成输入：容器配额 /
  内存受限 / env 覆盖 / 极小内存不为 0 / 单价表同源）。

### 2) 四个消费点

| 消费点 | 旧口径 | 新口径 |
| --- | --- | --- |
| `scripts/check-workspaces.mjs` 阶段 2 | `min(4, CPU)` | `values.packageBuild`，并给子进程下发内存安全的 `VITEST_MAX_WORKERS`（4 核 8GB 算出来仍是 3，不拖慢桌面套件；16 核 4GB 容器压到 1） |
| `prebuildWorkspaceDeps` | 串行 | 按依赖层并行（`values.prebuild`） |
| `packages/host/desktop/vitest.config.ts` | Linux 不限（win 2） | `values.vitestWorkers`（win 仍封顶 2） |
| `server/Makefile` `TEST_PARALLEL` / `GO_BUILD_P` | 写死 4 / 无 | `--print goTestParallel` / `--print goBuildParallel` |

### 3) 预构建并行（`prebuild-workspace-deps.ts`）

- 函数改成 `async`：按 `WORKSPACE_PACKAGES[*].deps` 现算**层**（同层无依赖、可并行），
  每层内先判增量（`stalenessReason`），再受限并发跑 `yarn workspace <pkg> build`，
  失败汇总后抛。六个调用点（verify-profile/session、package-linux/mac/win、release-mac、
  package-dir）改成 `await`。
- **表是并行安全的唯一真源**。并行化当场炸出一条历史欠账：`account-card` 的 `src/` import 了
  `@zeokeel/dsh-enterprise/*` 与 `@zeokeel/dsh-panel-surface/client`，但表里只登记了
  `desktop` —— 串行时靠列表顺序兜住，没人发现；并行后落到同层，读到 `enterprise` 的
  tsdown `clean` 窗口 ⇒ `TS7016 Could not find a declaration file`。已补齐并加判据
  `packages/host/desktop/tests/prebuild-dependency-table.spec.ts`（表可解析 / 无环 /
  `src/**` 的 `@zeokeel/*` import 都在 deps 里；变异删一条边即红）。

### 4) 内循环（新脚本 + 新命令）

- `scripts/dev-watch.mjs`：`tsdown --watch`（增量 ~300ms）+ 应用自动重启（250ms 防抖）；
  `--no-app` / `--no-restart` / `--types`（附带 `tsc --watch` 产 d.ts）。
- `dev:fast` = `brand-prepare + tsdown + node lib/bin.js`：**不产 `lib/types`**（dev 运行期
  不需要；实测删掉后 `bin.js --version/--help` 正常）。
- 根脚本转发：`yarn dev:watch` / `yarn dev:fast`。

### 5) 服务端

- `TEST_PARALLEL` / `GO_BUILD_P` 缺省取 capacity；`build-server` 的两条 `go build` 加 `-p`。
- 保持既有事实不变：Go 冷缓存 41s / 热缓存 1.4s（`cmd/server`，4 核实测）；DB 用例走模板库
  克隆；`-count=1` 只在门禁。**调高 `TEST_PARALLEL` 必须同步调大 `TEST_TIMEOUT_PARALLEL`**
  （它的推导依据是 `-p 4` 的实测膨胀，已在 Makefile 长注释里写明）。

### 6) 文档

- `AGENTS.md` 新增「编译与验证速度（性能口径，AI 改代码前先读这一节）」：口径 / 覆盖口 /
  TS7 双编译器 / 内循环命令矩阵 / 服务端纪律。**这一节是给下一个 AI（和人）的操作说明**，
  不是流水账。

## 实测（4 核 / 11GB，2026-10-23）

| 场景 | 改造前 | 改造后 |
| --- | --- | --- |
| `prebuild` 全量（15 包，`DSH_PREBUILD=force`） | 39s | **19s** |
| 开发内循环重建（改一行，`tsdown --watch`） | 2.2s（整链 build） | **~0.3s** |
| `dev:fast` 起应用 | 8.5s（TS6）/ 2.2s（TS7） | **~2s** |
| `yarn check` 阶段 2 并发 | 固定 4 | 4（本机；16 核 64GB 上 8） |
| `make test-server` 包并发 | 固定 4 | 4（本机；由 capacity 算） |
| `go build ./cmd/server`（冷/热） | 41s / 1.4s | 41s / 1.4s（`-p` 只影响冷缓存/多包改动） |

不同机型的折算（同一模块、同样的输入）：

| 机型 | 包并发 | prebuild | vitest | go test | go build |
| --- | --- | --- | --- | --- | --- |
| 2 核 / 2GB | 2 | 2 | 1 | 1 | 2 |
| 4 核 / 8GB（本机） | 4 | 4 | 3 | 4 | 4 |
| 8 核 / 16GB | 8 | 8 | 6 | 8 | 8 |
| 16 核 / 64GB | 8（硬顶） | 8 | 8 | 8 | 8 |
| 16 核 / 4GB 容器 | 4 | 4 | 8 | 2 | 5 |

## 验证

- `yarn check`：**34/34 PASS**（新判据 spec 随 desktop 阶段跑；`check:check-workspaces` 的
  509 条断言全绿，含"探针树必须拷编排器运行期依赖"的接线）。
- `check:guard-parser-integrity`：17 条守卫摘要 + 解析器包 + 执行体入口全绿（digest 已按
  `--print-digests` 更新；两条守卫脚本新增了"把 `build-capacity.mjs` 拷进探针树"的接线）。
- `verify-check-workspaces.mjs`：合成树 30 个场景 / 自检 13 条全绿。
- `make build-server`（webadmin 构建 + 两条 `go build -p`）：通过。
- 变异：删掉 prebuild 表的一条边 ⇒ 新判据红；改 `typescript` 版本 ⇒ 编译器判据红。

## 风险 / 已知代价

- **prebuild 表必须完整**：并行后缺边只在并发下炸（串行看不出来）—— 已加判据，新增包或
  新增 `@zeokeel/*` import 时判据会拦。
- `prebuildWorkspaceDeps` 变成 async：六个调用点必须 `await`（漏一个会出现"打包时依赖没构建完"
  的竞态，且不报错）。已在同一提交里全部改掉。
- `TEST_PARALLEL` 自适应与 `TEST_TIMEOUT_PARALLEL` 的耦合：超时依据是 `-p 4` 的实测膨胀，
  **超过 8 时需要重新标定超时**（Makefile 注释已写明）。
- 容器里 cgroup 版本差异（v2 / v1）都做了回退；读不到时退回"逻辑核 + `MemAvailable`"，
  再读不到按 4GB 可用算。

## 遗留

- desktop 的 8 个 `verify:*` 脚本仍是串行（~18s），它们之间有 `lib/` 的读写重叠，没有贸然并行。
- webadmin 的变体矩阵（4 × 单测）与产物判据（5 × vite build）仍是串行分钟级；属于发布判据，
  `check-fast` 不含。
- `yarn check` 里仍有 ~40 次 `yarn` 进程启动（每次 ~0.4s）；要再压需要把包级脚本改成直接调
  `node_modules/.bin`（会牵动 `check-install-integrity` 的执行点推导，未做）。
