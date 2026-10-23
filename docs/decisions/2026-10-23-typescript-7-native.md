# 2026-10-23 TypeScript 7 原生编译器迁移（`tsc` 6.0.3 → 7.0.2）

## 背景

开发循环里"编译等待"的绝对大头是 `tsc`。4 核 / 11GB 机器上的实测（2026-10-22/23）：

| 场景 | 6.0.3 实测 |
| --- | --- |
| `dsh-plugin-desktop` `build`（brand-prepare + clean + tsdown + 2×`tsc --emitDeclarationOnly`） | **8.5s** |
| `dsh-plugin-desktop` `typecheck:tests`（2×`tsc --noEmit`） | **11.9s** |
| 全仓 28 个 `tsconfig*.json` 串行跑一遍 | **110.6s** |
| `prebuildWorkspaceDeps`（15 个包，`DSH_PREBUILD=force`） | **112s** |

TypeScript 7（Go 原生编译器，`typescript@7.0.2` 的 bin 仍叫 `tsc`）在同样的 28 个配置上只要
**17.8s**（6.2×；逐配置 6–15×），声明产出与 6.x **语义等价**（见"验证"）。本文件记录迁移形态。

## 改造

1. **15 个 workspace 包** `typescript: "6.0.3"` → `"7.0.2"`（`@zeokeel/dsh-cron` 原来的
   `~5.7.2` 一并统一）。
2. **3 个包**（`dsh-plugin-desktop` / `@zeokeel/dsh-connectors` / `@zeokeel/dsh-enterprise`）
   另挂 `"typescript6": "npm:typescript@6.0.3"`。
3. 这 3 个包里 **10 个守卫 spec** 的 `import ts from 'typescript'` → `'typescript6'`。
4. 新判据 `packages/host/desktop/tests/typescript-compiler.spec.ts`（随 `yarn check` 的
   desktop 阶段跑）。
5. **`server/webadmin`**（独立的 npm 工程，原来 TS 5.9.3）：`typescript` → `^7.0.2`，并删掉
   `tsconfig.json` 的 `baseUrl`（TS7 已移除该选项，报 `TS5102`；无 `baseUrl` 时 `paths` 相对
   tsconfig 目录解析，`"@/*": ["./src/*"]` 原样可用）。

workspace 包的构建脚本**一个字都没改**：所有 `tsc -p …` 原样，靠依赖解析换编译器。

### 为什么不能"纯 TS7"（第 2/3 步的原因）

`typescript@7` 只提供 **CLI**：`exports["."]` 只剩 `{version, versionMajorMinor}`。编译器 API
在 `typescript/unstable/*`：

- 有全套 `isXxx`、`SyntaxKind`/`ScriptKind`/`ScriptTarget`、`node.forEachChild()` 方法；
- **没有**"从源码文本解析成 AST"的入口（`createSourceFile(statements, …)` 是工厂建节点，
  不是解析），也**没有** `createProgram` / `CompilerHost` / `TypeChecker`。

而那 10 个 spec 是架构/安全守卫（`wait-budget-contract.spec.ts` 3989 行、`network-policy`
747 行、`debug-switches` 659 行…，用到 ~60 个 `ts.*` 符号，`fatal-boot.spec.ts` 还自建
`CompilerHost` 跑 `getSymbolAtLocation`）。把它们重写到 `unstable/*`（明确标注不稳定的 API）
代价远大于收益，**留 6.x 做 API、7 做编译器**是正解。

### 关键实现细节（最容易静默坏的一条）

yarn 的**脚本 shim** 与 `node_modules/.bin` 的链接**不是同一套选择**（2026-10-23 用独立
yarn 工程实测）：

| 形态 | `yarn run` 里的 `tsc --version` | `node_modules/.bin/tsc` 指向 |
| --- | --- | --- |
| `typescript@6` + `typescript7: npm:typescript@7` | **6.0.3** | typescript7（7） |
| `typescript@7` + `typescript6: npm:typescript@6` | **7.0.2** | typescript（7） |

即：`.bin` 链接是"包名排序在后者覆盖"，而**脚本 shim 选的是 dependency 名为 `typescript`
的那一个**。所以正确形态只能是"`typescript` = 7、别名叫 `typescript6`"——反过来（6 当
`typescript`、7 当别名）会让 `.bin` 看着是 7、**脚本里实际跑 6**，编译悄悄退回慢档而门禁全绿。

这条约定不在任何 manifest 里，所以由 spec 的**行为判据**兜住：抽样 4 个包实跑
`yarn exec tsc --version`，必须全是 7.x。

## 实测结果（同一台机器）

| 场景 | 6.0.3 | 7.0.2 | 倍数 |
| --- | --- | --- | --- |
| desktop `build` | 8.5s | **2.2s** | 3.9× |
| desktop `typecheck:tests` | 11.9s | **2.4s** | 5.0× |
| 全仓 28 个 tsconfig | 110.6s | **17.8s** | 6.2× |
| `prebuild` 全量（15 包） | 112s | **39s** | 2.9× |
| webadmin `tsc -b`（`npm run build` 里的编译段） | 14.5s | **~2s** | 7× |
| webadmin `npm run build` 总时长 | — | 13.3s（其中 vite build 10.9s） | — |

## 验证

- **`yarn check` 全量：34/34 任务通过（PASS），299.8s**（同一棵树、同一台机）。
  注意这条口径要谨慎读：基线 371s 那次含一次与编译无关的 flake，且守卫/测试自身抖动很大
  （`check:ci-scripts` 85→67s、`dsh-memory-evolve` 99→43s 都与 TS 无关）。**编译只占门禁的
  一小部分**：desktop 阶段 85.1s → 83.2s（省下的 ~16s 是 build + typecheck:tests，剩下的
  83s 是 vitest 与 8 个 verify 脚本）。真正放大收益的是内循环与冷构建（上表）。
- 编译器 API 的 10 个 spec：`debug-switches` + `wait-budget-contract` 80 tests 通过。
- 新增判据 `typescript-compiler.spec.ts`：6 条断言，2.9s（含 4 次 `yarn exec tsc --version` 实跑）。
- **webadmin**：`npm run build` ✓（tsc -b + vite）；`npm test` 61 files / 972 tests ✓；
  `check:variant-tests` 4 个非缺省变体 ✓；`check:features` 5 个产物级变体 ✓。
- **声明产物对照**：371 个 `.d.ts` 里 346 个与 6.x 产物**逐字节相同**，22 个只差引号风格，
  3 个只差联合成员顺序（语义等价）。
- **混合工具链**：把 7 的产物覆盖回各包 `lib/types`，再用 **6.0.3** 跑 28 个配置 —— 全绿
  （灰度和回滚都安全）。
- **变异**：把 desktop 的 `typescript` 改回 `6.0.3` ⇒ 3 条判据红；把一个 spec 改回
  `import ts from 'typescript'` ⇒ 1 条红。

## 代价与风险

- `tsdown` 的 `peerDependencies` 只声明 `typescript: ^5.0.0 || ^6.0.0` ⇒ `yarn install` 会增加
  peer 警告（YN0060）。本仓所有包 `dts: false`，且 tsdown 运行期只静态 import
  `rolldown-plugin-dts/internal`（内部只用 `get-tsconfig`），**不加载 typescript** ⇒ 构建不受
  影响。等 tsdown 放行后可消掉警告。
- 安装体积：TS7 是**平台二进制包**（`@typescript/typescript-linux-x64` 27MB +
  `linux-arm64` 26MB —— 因为 `.yarnrc.yml` 的 `supportedArchitectures` 同时要 x64/arm64）⇒
  每个声明 typescript 的包多 ~53MB，15 个包约 **+800MB** node_modules，CI 缓存要留量。
- 别依赖 `node_modules/.bin/tsc` 路径：本仓形态下它现在也是 7，但脚本路径（`yarn run`）才是
  权威口径，判据也只盯脚本路径。

## 遗留 / 后续

- `packages/vendor/memory-evolve/tsconfig.json` 也有 `baseUrl` + `ignoreDeprecations: "6.0"`，
  但它不跑 `tsc`（esbuild 构建），本轮不动。
- `yarn dev:watch`（`tsdown --watch` 增量实测 335ms + `tsc --watch`）尚未接线，是内循环提速的
  下一步。
