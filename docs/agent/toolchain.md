# 工具链清单（安装什么 / 为什么 / 怎么验证 / 谁能复用）

> 规则：**版本钉死**；装完必须能跑一条验证命令；每个工具都要写清"它判什么、不判什么"。
> 本文件是 `package.json` 之外唯一的"该装什么"的人读清单；机器真源仍是根 `package.json`。

## 1. 必需（所有开发者 / agent）

| 工具 | 版本 | 安装 | 验证 |
| --- | --- | --- | --- |
| Node.js | `^22.19.0` 或 `>=24.0.0`（根 `engines`） | nvm / fnm / 系统包 | `node -v` |
| Corepack + Yarn | `yarn@4.18.0`（根 `packageManager`） | `corepack enable` | `corepack yarn --version` |
| Git | 任意近期版本 | 系统包 | `git --version` |
| Git 子模块 | 跟随 `deepseek-harness/` pin | `git submodule update --init --recursive` | `git submodule status` |
| Go | `1.26.6`（`server/go.mod`） | 官方安装包 | `cd server && go version` |

依赖安装：**只用** `corepack yarn install --immutable`。不要 `npm install`（nodeLinker 是
`node-modules`，混用会改写 `node_modules` 布局与 `.yarn/cache`）。

## 2. 已入库的架构工具（S2）

### 2.1 `dependency-cruiser@18.7.0`（TS 侧，根 devDependency）

```bash
# 装（已写入 package.json + yarn.lock；新机器只需 install）
corepack yarn install --immutable

# 验证
corepack yarn dependency-cruiser --version        # 期望 18.7.0
make -f Makefile.agent arch-ts                    # 期望 exit 0

# 直接跑（等价于上面 target 的内部命令）
corepack yarn dependency-cruiser packages community \
  --config .dependency-cruiser.cjs \
  --ignore-known .dependency-cruiser-known-violations.json
```

- **判什么**：循环依赖、`deepseek-harness/` 子模块直引、TS 代码引 Go 源码、
  包内 `src/host` ↔ `src/client` 互引、`packages/vendor/**` 反向依赖、`community/fabric` 依赖产品包、
  非 desktop 的 host 包反向依赖 `packages/host/desktop`。
- **不判什么**：类型级依赖（`import type` 被剥离）、运行时行为、`server/`（Go 由另一工具管）。
- **为什么必须配 SWC**：本仓 `typescript` 是 7.0.2 原生编译器，其 JS 包没有
  `transpileModule`/`createProgram`；dependency-cruiser 默认的 tsc 解析器会**静默跳过全部
  `.ts/.tsx`**（实测 146 个模块里 118 个 TS 是配上 `parser: 'swc'` 之后才进来的）。
  `@swc/core@1.16.20` 是根 devDependency，版本必须落在 dependency-cruiser 的
  `>=1 <2` 支持区间（见其 `src/meta.cjs`）。
- **基线**：`.dependency-cruiser-known-violations.json` 是**存量例外登记**。新增违规必须修；
  若要接受，重跑 `--output-type baseline` 并在 PR 里说明——**基线只能缩不能放**。
- **已接门禁（2026-10-26）**：第 19 条根守卫 `check:architecture`（判据本体
  `scripts/check-architecture.mjs`）在每次 `corepack yarn check` 与 CI `gate` job 里跑**同一组参数**；
  `make -f Makefile.agent arch-ts` 只是内循环便利入口。判据自身跑不起来（规则/基线/主程序缺失）
  ⇒ 退出码 2（fail-closed），不会被读成"没有违规"。

### 2.2 `go-arch-lint@v1.19.0`（Go 侧，二进制，不入 repo）

```bash
# 安装（模块缓存写到仓库内可写目录，避免只读 home）
cd server
GOCACHE="$PWD/temp/gocache" GOMODCACHE="$PWD/temp/gomodcache" GOPATH="$PWD/temp/gopath" \
  go install github.com/fe3dback/go-arch-lint@v1.19.0
"$PWD/temp/gopath/bin/go-arch-lint" --help

# 验证（基线即配置：exit 0 = 没有新增包级依赖边）
make -f Makefile.agent arch-go
```

- **判什么**：Go 包级依赖方向（components + `mayDependOn`）。判据本体 =
  `server/.go-arch-lint.yml`（schema version 3，64 个组件 / 198 条允许边，机械生成）。
- **当前状态：已启用（基线即配置）**。配置冻结的是**当前生产 import 图**，不是理想分层：
  **生产 import 图是 DAG（无环）**，环只出现在 `*_test.go` 里（4 个测试侧 SCC）；配置用
  `excludeFiles: ^.*_test\.go$` 排除测试依赖 —— 代价诚实记账：**含测试会多 87 条违规命中**
  （65 个「组件 × import 包」对 = 50 条跨组件边 + 15 条外部测试包 import 自身包；命中数 ≠ 唯一边数），
  所以"测试期依赖不拦"是有意选择（要连测试侧一起拦是另一次评审，不是顺手改）。
  新增一条合法方向的边**也会红**（必须改配置 + 评审）；删配置里一条已有边即红（配置本身是回归判据）。
  设计记录与收紧流程：`docs/agent/architecture.md` §3。
- **为什么不用 `depguard`**：它只判"文件能不能 import 某前缀"，不判层次/方向；
  `go-arch-lint` 直接比对"实际依赖图 vs 声明图"，更贴这里要防的 bug（放错层）。

## 3. 可选（按阶段引入，不要一次全装）

| 工具 | 版本 | 用途 | 安装 | 何时值得装 |
| --- | --- | --- | --- | --- |
| `@stryker-mutator/core` | `10.1.1` | 变异测试：证明测试真的锁住行为 | `corepack yarn add -D @stryker-mutator/core@10.1.1` | 有"修完测试全绿但 bug 还在"的历史时；`incremental` 只跑改动 |
| `fast-check` | `4.10.2` | 性质测试：状态机/边界/不变量 | `corepack yarn add -D fast-check@4.10.2` | 涉及解析、状态机、边界换算的模块 |
| Go `-fuzz` | 内置 | 模糊测试，失败输入自动进 `testdata` | 无需安装 | 解析器、协议编解码 |
| `gremlins` | 最新 | Go 变异测试（慢，抽样用） | `go install github.com/go-gremlins/gremlins@latest` | 只在发布前抽样，不进内循环 |
| `@fission-ai/openspec` | `1.15.0` | 规格/变更框架（`validate` 可进 CI） | `corepack yarn dlx @fission-ai/openspec@1.15.0` | 团队决定采用 spec-first 时；否则用本仓 `changes/` |
| OpenSpec 之外的 SDD 工具 | — | 规格前置 | 各自 CLI | **不建议**在本仓引入：本仓已有更硬的判据，且实测 markdown 体量会拖慢评审 |

## 4. 明确"暂不引入"（附理由）

| 工具 | 结论 | 理由 |
| --- | --- | --- |
| `@typescript-eslint`（type-aware） | 暂缓 | 其 peer 上限是 `typescript <6.1`，与本仓 TS `7.0.2` 不兼容；`no-floating-promises` 这类规则暂时靠 review + 测试兜底。**TS7 支持后再评估。** |
| `eslint-plugin-boundaries` | 暂缓 | 依赖 ESLint；边界判据已由 dependency-cruiser 覆盖。 |
| `ts-arch` | 不用 | 依赖 TS 编译器 API，与 TS7 不兼容；能力也弱于 dependency-cruiser。 |
| 任何 LLM code review 当门禁 | 不采用 | 厂商自评基准、误报成本不可控；只作为人工评审前的补充传感器。 |

## 5. CI 侧（已存在，不要重复安装）

| 判据 | 位置 | 备注 |
| --- | --- | --- |
| `yarn check`（20 根守卫 + 17 包） | `.github/workflows/ci.yml` `gate` job | 本地同义：`corepack yarn check` |
| CodeQL | `.github/workflows/codeql.yml` + `docs/decisions/2026-10-04-codeql-fork-pr-coverage.md` | 已有，含 fork PR 覆盖 |
| Go gate | `server` job（gofmt + vet + `go test -p4`） | 本地 `make -C server check-fast` |
| 打包/E2E | `desktop-linux/win/macos` jobs | `e2e:client` 只在 linux job |

## 6. 新机器上手自检

```bash
make -f Makefile.agent doctor
```

`doctor` 会逐项打印：node / yarn / git / submodule / go / dependency-cruiser / go-arch-lint 的
版本与"是否必备"。缺必备项时 exit 1；缺可选工具只提示（exit 0）。
