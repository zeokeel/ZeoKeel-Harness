# CodeQL 页面脚本告警的处置（2026-10-24）

- 状态：已接受（accepted risk），告警以「won't fix」关闭并记录此处
- 相关 PR：#6（内置浏览器能力清单 + `browser_run`）
- 相关告警：`js/bad-code-sanitization` 5 处（`eval-policy.ts` ×1、`snapshot.ts` ×2、`runtime.ts` ×2）

## 告警是什么

CodeQL 把「把外部字符串拼进将被执行的代码」标记为 bad code sanitization。命中的 5 处正是内置浏览器**设计上**的页面脚本构造点：

1. `eval-policy.ts` 的 `wrapEvalExpression`：`browser_eval` 的表达式包装器 —— 该工具的**语义就是**在页面上下文执行模型编写的表达式；
2. `snapshot.ts` / `runtime.ts` 把 **选择器** 通过 `JSON.stringify` 拼进 `Runtime.evaluate` 的页面脚本 —— 选择器来自工具参数，意图是在页面里查询元素。

## 为什么接受而不是改代码

- **页面上下文本来就是非可信上下文**：脚本在标签页渲染器里执行，模型已拥有 `browser_eval` 这一显式能力（A7 记录）。"把值拼进页面代码"不会提权——它作用的上下文与页面自身等价。
- **入口已有多层闸门**：`browser_eval` 表达式先过 AST 白名单校验（`eval-policy.ts` 的 `validateEvalExpression`）、凭据窗口禁止 eval、用户闸与全局 op 日志；选择器路径只做 DOM 查询，且被 `stale-snapshot`/锚点/脱敏约束。
- **改写为参数传递代价高且收益低**：把 5 处全部改成 `Runtime.callFunctionOn(arguments)` 需要改 frame/OOPIF 上下文解析与 200+ 用例的 mock 形态；对于**本来就是页面脚本**的能力，这是"在同一个信任域里换写法"，不改变能力边界。
- **本次已消除真正的可修项**：role/`>>>` 选择器的多项式正则（ReDoS）已改为有界字符类；vendored Acorn（byte-for-byte 上游解析器）与测试夹具已通过 CodeQL 配置排除（`.github/codeql/codeql-config.yml`）。

## 结论与后续

- 5 条告警以 `won't fix` 关闭，理由指向本文档（accepted risk）。
- 若未来把页面脚本构造统一迁移到 `callFunctionOn(arguments)`，再重新开启对应规则；届时需要同步重写 frame/selector 的测试替身。
- 威胁模型与既有决策一致：见 `docs/decisions/2026-09-21-app-author-data-surface.md`、`docs/planning/2026-10-23-browser-lock-order.md`。
