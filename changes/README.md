# 变更记录（changes/）

一条记录 = **一次意图**：为什么改、改哪里、**怎么算完成**、怎么回滚。
目的：把"设计细节"从会话上下文里捞出来，变成下一个 agent/人可直接读的事实。

## 什么时候必须写

- 修 P0/P1（以及任何线上事故的根因修复）；
- 跨包 API / 契约变更（含 Go `/api/*` 与客户端子路径导出）；
- 新增/修改**判据**（守卫、规则集、基线）；
- 新增工具/依赖（`docs/agent/toolchain.md` 登记 + 本记录）。

纯文案/小重构可跳过。

## 命名与生命周期

```
changes/2026-10-26-<kebab-slug>.json
status: proposed → accepted → implemented → verified
```

- `proposed`：只有意向，未评审；
- `accepted`：**验收标准已定稿**（必须 ≥1 条可证伪），可以开始写代码；
- `implemented`：代码完成，验收尚未全部通过；
- `verified`：每条 `acceptance` 都有实际命令输出（把命令与关键输出贴进记录或 PR）。

## 字段规则

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 文件名去扩展名，全局唯一 |
| `status` | 是 | 上面四态之一 |
| `intent` | 是 | `{zh,en}` 各一句：**为什么**（不是"改了什么"） |
| `modules` | 是 | 仓库相对路径数组（文件或目录）；空的用 `[]` |
| `acceptance` | accepted 起必填 | `[{criterion, evidence, command}]`；`evidence` ∈ `test\|guard\|probe\|manual`；`manual` 必须写清人工步骤 |
| `risk` | 否 | 失败时的爆炸半径（数据/安全/回滚难度） |
| `rollback` | 否 | 怎么安全回退（flag/迁移/回滚脚本） |
| `verification` | verified 起必填 | `[{command, result}]`：实际跑的命令与结论 |

## 验收标准写法（唯一硬要求）

**能回答"跑什么、看到什么、算通过"**。否则不合法：

- ❌ "界面正常显示" / "逻辑正确" / "符合预期"
- ✅ "`vitest run tests/x.spec.ts` 全绿；回退实现后该用例变红"
- ✅ "`make -f Makefile.agent arch-ts` exit 0 且基线未增长"
- ✅ "e2e 报告首行 `结果：N/N 通过`，且 N 与改动前一致"

## 与其它记录的关系

- **决策**（长期约束、为什么这么定）→ `docs/decisions/`；
- **计划/方案**（大改动的前期设计）→ `docs/planning/`；
- **变更**（一次可关闭的单位）→ 本目录；
- **结构**（模块/API/依赖的形状）→ 结构库（如已建立）或 `docs/agent/architecture.md`。

## 模板

复制 [`_template.json`](./_template.json) 改名即可。不要提交 `proposed` 状态的空记录
（除评审用草稿外）。
