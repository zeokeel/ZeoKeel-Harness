# Agent 开发环境（索引）

本目录是**给 coding agent 与人类开发者共用**的环境说明。目标只有一个：**任何人（或 agent）在
任何机器上，用同一套命令得到同一套判据**。格式遵循 AGENTS.md 约定：先给可执行命令，再给理由。

> 入口：根 `AGENTS.md` 是操作手册（先读它）；本目录是展开说明。
> 嵌套规则：`server/AGENTS.md`（Go 服务端）就近优先。

## 0. 一页启动（新机器 / 新开发者 / 新 agent）

```bash
git clone --recurse-submodules <repo>
# 已经 clone 过但没带子模块：
git submodule update --init --recursive
corepack enable
corepack yarn install --immutable
node scripts/check-workspaces.mjs --list     # 确认 17 个包 + 20 条根守卫
make -f Makefile.agent doctor                # 检查本机工具链是否齐全
```

服务端（可选，改 `server/` 时才需要）：

```bash
cd server && go build ./cmd/server            # 热缓存约 1.4s
```

## 1. 分阶段工具矩阵（**按需安装，不要一次全装**）

| 阶段 | 解决什么 | 工具（版本钉死） | 安装命令 | 验证命令 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| **S0 基线** | 能构建、能跑门禁 | Node `^22.19.0\|\|>=24`、Corepack Yarn `4.18.0`、Git、Go `1.26.6` | 见 §0 | `node scripts/check-workspaces.mjs --list` | **已具备** |
| **S1 上下文与变更** | agent 知道"在哪写、写成什么样、怎么算完成" | 根 `AGENTS.md` + 嵌套 `server/AGENTS.md` + `changes/` 变更记录 | 仓库自带，无第三方 | `make -f Makefile.agent doctor` | **已落地** |
| **S2 架构判据** | 依赖方向/分层/"放错位置" | `dependency-cruiser@18.7.0`（TS）+ `go-arch-lint@v1.19.0`（Go） | `make -f Makefile.agent install-arch` | `make -f Makefile.agent arch arch-go` | **TS 已接门禁（第 19 条 `check:architecture`）；Go 已启用（基线即配置）** |
| **S3 行为验证** | 测试是否真锁住行为、边界/契约 | `vitest`（已有）、`CodeQL`（CI 已有）、`@stryker-mutator/core@10.1.1`、`fast-check@4.10.2`、Go `-fuzz`（内置） | 见 `toolchain.md` §3 | 各自 `--version` / 跑一次 | **建议引入（按需）** |
| **S4 观测与固化** | 线上/真机反馈回流成判据 | `e2e:client` / `e2e:real`（已有）、GlitchTip 核查（已有）、`docs/planning/2026-09-25-si-self-improvement-loop.md` 的固化清单 | 仓库自带 | `node packages/host/desktop/scripts/e2e-client.mjs` | **已有，固化未闭环** |

**选择原则（来自 2026 行业调研，见 `tooling-research` 结论）**：
1. 先补**确定性传感器**（类型/依赖/契约/变异），再谈 LLM 评审；
2. 结构类问题**只有计算型工具**能可靠接住；
3. 每个工具必须有"一条命令 + 非零退出"的验证，否则只是文档。

## 2. 工具清单与可复现性

- 逐工具的安装命令、版本、验证方式、是否已接门禁：见 [`toolchain.md`](./toolchain.md)。
- 依赖声明位置：**唯一真源是根 `package.json` 的 `devDependencies` + `yarn.lock`**；不要用
  全局 `npm i -g` 装本仓工具（除 Go 二进制与 CLI 例外，见 toolchain §2/§3）。
- 新增工具的三条纪律（仓规）：
  1. 版本**钉死**（不许 `^` 漂移进关键判据）；
  2. 工具必须能在**离线/受限网络**下给出可行动的失败信息；
  3. 改判据（规则集/基线）与改代码**分开提交**，判据变更单独评审。

## 3. 变更记录（S1 的核心产物）

- 模板与字段：[`changes/README.md`](../../changes/README.md)。
- 规则：**任何 P0/P1 修复、任何跨包 API 变更、任何新增工具/判据**，都要在 `changes/` 留一条记录；
  记录里的 `acceptance` 必须是**可证伪**的（能写成测试/命令），不是"看起来对"。
- 字段契约已门禁化（2026-10-26）：第 20 条根守卫 `check:change-intent`
  （`scripts/check-change-intent.mjs`）在每次 `yarn check` 里校验 `changes/*.json`
  （跳过 `_template.json`），坏 JSON / 未知 status / 未知 evidence / accepted 起缺 `acceptance` /
  verified 起缺 `verification` 一律 EXIT 1，`changes/` 目录缺失 EXIT 2（fail-closed）。

## 4. 已知边界（诚实记账）

- `dependency-cruiser` 在本仓跑 TS **不经过 TypeScript 编译器**（本仓 TS 7.0.2 的 JS 包没有
  `transpileModule`），而是用 SWC 解析（`parser: 'swc'`）。因此它看到的是 **AST 里的 import/export**，
  不做类型推断。
- `@typescript-eslint` 的 peer 上限目前是 `typescript <6.1`，与本仓 TS 7 不兼容 ⇒ **type-aware
  ESLint 暂不引入**（`no-floating-promises` 这类规则暂时靠 review + 测试兜底）。
- `go-arch-lint` 是**基线即配置**（`server/.go-arch-lint.yml`）：已启用，冻结当前生产 import 图
  （生产图 DAG，测试期环已排除，见 `architecture.md` §3）；新增边要改配置并评审。
