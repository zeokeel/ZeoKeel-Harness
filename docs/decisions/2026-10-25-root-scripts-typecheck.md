# 根脚本的类型检查：`allowJs + checkJs`（TypeScript 7，不换扩展名）

日期：2026-10-25
状态：已落地（`tsconfig.scripts.json` + `yarn typecheck:scripts`）

## 问题

仓库里被 git 跟踪的 `.js/.mjs/.cjs` 共 357 个、约 19.9 万行，但**只有 vendor 与示例之外的两个
workspace 包**在 `yarn typecheck` 面内。真正承重的那一层——根 `scripts/**`（48 个文件、
约 7 万行，17 条根守卫 + CI 判据执行体）——**一行类型检查都没有**：它们按 `.mjs` 由 `node`
直接跑，没有 tsconfig 覆盖，也没有 `// @ts-check`。

它们的类型信息其实**已经写在代码里**：这些脚本长期用 JSDoc 写 `@param` / `@returns` /
`@type`（大量注释解释了每条判据的判据面）。缺的只是"谁来读这些 JSDoc"。

## 决策

新增根级类型检查工程 `tsconfig.scripts.json`，用 `allowJs + checkJs` 把 `scripts/**`
**原样**纳入 TypeScript 7 检查：

- **不换扩展名、不引入构建**：文件仍是 `.mjs`，Node 仍原样执行；类型信息只来自 JSDoc。
- 编译器与全仓一致：根 `devDependencies` 加 `typescript@7.0.2` + `@types/node@^22.20.0`
  （根此前只有 `yaml`，`node_modules/.bin/tsc` 不存在，所以脚本无法从根跑 tsc）。
- 入口：`corepack yarn typecheck:scripts`（= `tsc -p tsconfig.scripts.json`）。
- `scripts/wasm/probes/**` **排除**：那 5 个 `.cjs` 是 Electron **渲染进程**里的探针
  （`window` / `location` / `require('electron')`），`lib: ES2024` + `types: [node]` 的工程
  只会产出假红；它们的类型面属于桌面包。

### 一个必须写下来的编译器事实

**TS 7 的 `strict` 缺省是 `true`**（TS 5/6 缺省是 `false`）。所以配置里显式写
`"strict": false` 是**基线取值**，不是"忘了写"；否则 `noImplicitAny` 一族会一次翻出
3000+ 条。TS7 已在本仓 15 个 workspace 包落地（`docs/decisions/2026-10-23-typescript-7-native.md`），
那块不受影响——那些 tsconfig 本来就显式写 `strict: true`。

## 落地的代价：176 条存量错误，全是 JSDoc 收敛

首轮全量跑出 176 条错误（17 个文件）。修法**不是改代码**，而是把作者写的 JSDoc 与实际形状
对齐，主要是四族：

1. `@param {object} [options]` + 正文里列出字段 ⇒ 改成精确的 inline 结构类型；
2. `@returns {object}` / `@returns {{…, x: object}}` ⇒ 删掉或换成真实形状（TS 自己推断更准）；
3. 解构参数上的 `@param`：TS 从 `= {}` 缺省值推断时会**丢掉没有缺省值的绑定**
   ⇒ 给解构参数写完整的结构类型（可复用的一行修法）；
4. Node API 的联合返回（`server.address()` → `string | AddressInfo`、
   `spawnSync().error` → `Error`、`process.reallyExit`、`ReadonlySet` 只读形状）
   ⇒ `@type` 窄化 + 就地 JSDoc cast。

顺带修掉/发现的三件真事（都不是类型问题本身）：

- **`scripts/verify-ci-scripts.mjs` 的模板字符串里有一处未转义的反引号**（``（含 `/` 的密码``）：
  整段 `check()` 的第二参数实际求值成 `NaN`，R8-D-9 的"clone 路径失败诊断不得回显凭据"断言
  **恰好在它该报话时丢掉诊断文本**。已转义为 `` \`/\` ``。
- **TS 解析器的 ASI 边界**：`() => ({ … })` 之后紧跟一个裸 `{ … }` 块时，TS 6/7 都按箭头体
  误判（`error TS1005: '=>' expected`），V8 按 ASI 接受。`scripts/check-integration-tests.mjs`
  里用**显式分号**断句（运行期语义不变，见该处注释）。
- **`scripts/doc-claims-passline-child.mjs` 的 `--root <dir>` 曾是"文档说判这棵树、实际判 cwd"**：
  父进程把 `--root` 透传给子入口，子入口解析后**直接丢弃**，而 `check-doc-claims.mjs` 在模块
  加载期按 `process.cwd()` 解析根 ⇒ 用 `--root` 跑时父子各判一棵树（探测失去意义）。已改成
  子入口在 import 前 `process.chdir(rootDir)`（进不去 ⇒ exit 2）。
- `scripts/gen-module-contract.mjs` 内部注释里的生成区计数曾漂移（写 10/8，实际 11/15）——
  已按 `MODULE_CONTRACT_FACE_COUNTS` 的实算值改正；同文件 `modules[].line` 是**从未被读过**
  的死字段，已删。

## 死代码也进判据（`noUnusedLocals` / `noUnusedParameters`）

只加 `checkJs` 能抓"用错"，抓不到"没人用"。所以同一轮把 `noUnusedLocals` +
`noUnusedParameters` 一起打开，并清掉 37 条 TS6133：

- 未使用的 import（`mkdtempSync` / `dirname` / `availableParallelism` / `spawn` /
  `spawnYarnFallbackGuard` 等）逐个删；
- 未使用的局部变量按"有副作用保留调用、只删绑定"的口径清；
- 未使用的函数（`hostFromDomain` / `PACKAGE_RUNNER_WORDS` / `SHELL_WORDS_CACHE` /
  `unreadableShellScriptArgument` / `guardCodeLines` 等）先全仓 grep 证明零引用再删；
- 未使用的参数（`documentWith(overrides)` 的首参）连调用点一起收掉。

从此**新增**的死代码会让 `check:scripts-types` 当场红。

## 边界（认账）

- 检查面只有**语法级类型**：`checkJs` 不做语法降级，也不跑任何东西。
- `strict: false` 下 `strictNullChecks` / `noImplicitAny` 是关的 ⇒ 空值路径与隐式 any
  仍不在判据面内。这是**下一步棘轮**（按文件收口，别一次翻）。
- 不含 `packages/*/*/scripts/**`（desktop 那 20 个 `.ts` 脚本已由桌面包的
  `tsconfig.tests.json` 覆盖；剩下 34 个 `.mjs` 可另开一块 `include`）。

## 门禁化：第 18 条根守卫 `check:scripts-types`

一个"没人跑的命令"不是判据。接入方式是**新增一条根守卫**（不是改 `check` 脚本体 ——
那一条被 `check-workflows.mjs` 钉成 `node scripts/check-workspaces.mjs`）：

| 触点 | 内容 |
| --- | --- |
| `scripts/check-scripts-types.mjs` | 判据本体：用**当前 node** 跑根 `typescript` 的 `tsc -p tsconfig.scripts.json`，退出码原样带出（读不到 tsc/配置 ⇒ exit 2，fail-closed） |
| 根 `package.json` | `"check:scripts-types": "node scripts/check-scripts-types.mjs"` |
| `check-workspaces.mjs` 的 `GUARDS` | 新条目（名字/argv/描述）⇒ `yarn check` 与 `check-root-guards.mjs` 自动带上它 |
| `check-root-guards.mjs` 的 `REGISTERED_GUARD_ENTRIES` | 名字 → 脚本路径 → sha256 摘要（改判据本体必须进 diff） |
| `check-install-integrity.mjs` 的 `EXECUTION_FACE_REGISTRY` | 新执行体登记（形状族的双向对账要求） |
| 文档 | `AGENTS.md` / 官网插件开发页的"根守卫数"与 `planned=N` 同步成 18 / 35 |

## 验证

```bash
corepack yarn typecheck:scripts          # 0 错误（含 noUnused*）
node scripts/check-root-guards.mjs       # 18/18 通过
node scripts/verify-check-workspaces.mjs # 513 条断言全过
node scripts/check-guard-parser-integrity.mjs  # 18 条守卫摘要与登记值一致
corepack yarn check                      # 全量 35 任务：35 通过
```

改判据脚本后照既有纪律更新摘要：`node scripts/check-guard-parser-integrity.mjs --print-digests`
（注意它打印的 `check-install-integrity` 摘要在**有未提交改动时是 HEAD 那份**，登记值要取
`sha256sum` 的工作树值）。
