# Agent 工作流（从开工到关闭）

> 一句话：**先写"怎么算完成"，再写代码；每条"完成"都要能在没有你的情况下被重跑。**
> 本流程与 `docs/playbooks/multi-agent-regression-audit.md` 互补：那份是"怎么审"，这份是"怎么干"。

## 0. 开工检查（30 秒）

```bash
git status --porcelain                 # 工作树干净吗？别人的改动不要 sweep 进来
git submodule status                   # 子模块 pin 对不对
node scripts/check-workspaces.mjs --list   # 17 个包 + 20 条根守卫（本机是否完整）
make -f Makefile.agent doctor          # 工具链是否齐全
```

**不满足就停**：子模块未 init、依赖未装、工具链缺必备项 —— 先修环境，不要在坏环境上写代码
（坏环境下写的"通过"没有意义）。

## 1. 侦察（先读，再写）

按顺序读，不要一上来就 grep 全仓：

1. 根 `AGENTS.md`（硬规则）→ 本目录 `architecture.md`（分层）→ 目标包的 `package.json` / `tsconfig`；
2. `server/**` 改动先读 `server/AGENTS.md`；
3. 相关决策：`docs/decisions/`（按日期倒序找同主题）与 `docs/planning/`；
4. 同族实现：先找"这件事是不是已经有人做过"（结构库/`grep` 入口名），
   **AI 最常见的错误不是写错，而是把已有的能力又实现一遍。**

## 2. 写"变更记录 + 验收标准"（**在写代码之前**）

在 `changes/<YYYY-MM-DD>-<slug>.json` 建一条记录（模板见 `changes/README.md`）。
硬要求：

- `acceptance` 至少 1 条，且每条必须能回答："**跑什么命令、看到什么输出，算通过**"；
- 如果验收要写"看起来对/符合预期"——**不合法**，改成测试断言、判据命令或探针；
- 涉及跨包 API/契约的，写明两端（生产端/消费端）与兼容策略。

## 3. 实现（按改动面选内循环命令）

见根 `AGENTS.md` 的"内循环命令矩阵"。要点：

- 改一行 TS/TSX：`corepack yarn dev:watch`（~0.3s）；
- 只跑单包门禁：`node scripts/check-workspaces.mjs --only <pkg>`；
- 只跑一组用例：`corepack yarn workspace <pkg> vitest run tests/x.spec.ts`；
- 改 Go：`cd server && go test ./internal/<pkg>/... -run <Name> -count=1`。

**纪律**：`yarn check` / `make check` / `dist:*` / `e2e:*` 不进内循环（分钟级）。

## 4. 分层验证（从快到慢，逐层过）

| 层 | 命令 | 期望 |
| --- | --- | --- |
| 单元/集成 | 目标 spec（见 §3） | 红 → 绿；**先有失败用例再做修复** |
| 包门禁 | `node scripts/check-workspaces.mjs --only <pkg>` | 0 失败 |
| 架构（TS） | `make -f Makefile.agent arch-ts` | 0 新增违规 |
| 架构（Go） | `make -f Makefile.agent arch-go`（`server/.go-arch-lint.yml` 启用后；当前手动入口，未进 CI） | 0 新增违规 |
| 全量（提交前） | `corepack yarn check` | 37 任务全绿（~300s） |
| 服务端（提交前） | `make -C server check` 或至少 `check-fast` | 全绿 |
| 行为/真机（按面） | `e2e:client` / `e2e:sidebar` / `e2e:terminal` / `e2e:real` | 见 `testing.md` |

## 5. 关闭（Definition of Done）

一条改动只有同时满足下面 5 条才算关闭：

1. `acceptance` 每一条都有**实际命令输出**（不是"应该可以"）；
2. 新增/修改的判据**能被打坏**（自己注入一次违规，确认它变红——变异自证）；
3. 工作树干净、`git diff` 只含本次意图内的改动；
4. 变更记录 `status` 改为 `verified`，写明验证命令与结果；
5. 若改了架构/契约/判据：在 `docs/decisions/` 或 `docs/planning/` 留一条记录（为什么这么定）。

## 6. 反模式（本仓历史事故的抽象）

| 反模式 | 现场长什么样 | 正确做法 |
| --- | --- | --- |
| 用"通过行"代替判据 | 脚本打印 ✅ 但没检查任何东西 | 判据必须能 `exit 1`，并用变异证明 |
| 让实现者自己写期望值 | 测试与实现同一个误解 | 期望值来自契约/fixtures/外部 evaluator |
| 大段一次生成 | 一次改 10 个文件、无法二分 | 小步提交，每步可验证 |
| 把门禁改绿 | 改守卫/改基线/加 advisory | 改判据必须单独 PR + 论证（见 `AGENTS.md`） |
| 只加脚本不接门禁 | `scripts/` 里有新工具但没人跑 | 接进 `yarn check` 或 `Makefile.agent`，并在文档登记 |

## 7. 收尾记录

- 项目进展写 `memory`（daily/project），长期约定写 `memory` key（需确认）；
- 结构性事实（新模块、新契约、新分层）写进 `docs/agent/` 或 `docs/decisions/`，
  不要只留在会话里 —— **会话结束即丢失**。
