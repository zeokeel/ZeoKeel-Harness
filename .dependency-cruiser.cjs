/**
 * dependency-cruiser 规则（架构 fitness function 的 TS 侧实现）。
 *
 * 用法（唯一入口，不要把命令抄成别的形态）：
 *   corepack yarn dependency-cruiser packages community --config .dependency-cruiser.cjs \
 *     --ignore-known .dependency-cruiser-known-violations.json
 *
 * 生成/刷新基线（只在**有意**接受一批存量违规时跑，并把 diff 交给评审）：
 *   corepack yarn dependency-cruiser packages community --config .dependency-cruiser.cjs \
 *     --output-type baseline > .dependency-cruiser-known-violations.json
 *
 * 纪律（与仓库既有门禁同源）：
 *   - 基线是**例外登记**，不是豁免：新增违规必须修，或**显式**写进基线并在评审里说明理由；
 *   - 规则只增不减、只紧不松；删规则/放宽 severity 属于"改判据"，必须单独评审；
 *   - 本文件是**判据本体**，改它等于改结论。
 *
 * 为什么只覆盖 `packages/` 与 `community/`：`server/` 是 Go（由 go-arch-lint 管），
 * `deepseek-harness/` 是上游子模块（永不改、不进判据），`docs/site/scripts` 不是产品代码。
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '循环依赖：AI 最容易在"顺手加一条 import"时引入，且只在特定加载顺序下炸。',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-submodule-internals',
      severity: 'error',
      comment: '产品代码不得直接引用上游子模块源码（只能走上游公开包）。',
      from: {},
      to: { path: '^deepseek-harness/' },
    },
    {
      name: 'no-server-import-from-product',
      severity: 'error',
      comment: 'TS 产品代码不得引用 Go 服务端源码（跨语言边界只走 HTTP 契约）。',
      from: { path: '^packages/' },
      to: { path: '^server/' },
    },
    {
      name: 'client-face-no-host-face',
      severity: 'error',
      comment: '包内 client 面（渲染进程）不得引用 host 面（主进程）：两者跑在不同进程/不同 bundle。',
      from: { path: '^packages/[^/]+/[^/]+/src/client/' },
      to: { path: '^packages/[^/]+/[^/]+/src/host/' },
    },
    {
      name: 'host-face-no-client-face',
      severity: 'error',
      comment: '包内 host 面（主进程）不得引用 client 面（渲染进程）。',
      from: { path: '^packages/[^/]+/[^/]+/src/host/' },
      to: { path: '^packages/[^/]+/[^/]+/src/client/' },
    },
    {
      name: 'vendor-is-leaf',
      severity: 'error',
      comment: 'vendored 第三方代码（packages/vendor/**）是叶子：不得反向依赖产品包。',
      from: { path: '^packages/vendor/' },
      to: { path: '^packages/(host|client)/' },
    },
    {
      name: 'community-fabric-is-scaffold',
      severity: 'error',
      comment: 'community/fabric 只是文档脚手架：在 schemas + 参考适配器评审前不得声明可加载入口。',
      from: { path: '^community/' },
      to: { path: '^packages/' },
    },
    {
      name: 'host-packages-no-desktop',
      severity: 'error',
      comment: 'desktop 是 host 面最顶层的装配者；除 desktop 自身外，host 包不得反向依赖它。'
        + '测试文件例外：集成/回归测试借用 desktop 的测试夹具（boot 脚本、runtime stub）是既有的、'
        + '有意的做法，不属于产品运行期依赖。',
      from: { path: '^packages/host/(?!desktop/)', pathNot: '/tests/' },
      to: { path: '^packages/host/desktop/' },
    },
  ],

  options: {
    // 外部依赖不跟进（node_modules 是第三方代码，不是本仓判据面）。
    doNotFollow: { path: 'node_modules' },
    // 构建产物与本地缓存不进判据面。
    exclude: {
      // 构建产物与本地缓存不进判据面；`.d.ts/.d.mts/.d.cts` 也不进 —— 它们是**声明**，
      // 不产生运行期依赖，且 SWC 解析器会把 "const 无初始化" 这类合法声明判成语法错误
      // （实测 `fetch-bundled-runtimes.d.mts` 会让整次扫描中止）。
      path: '(^|/)(node_modules|lib|dist|build|out|coverage|temp|\\.yarn|\\.e2e-shots)/|\\.d\\.(?:m|c)?ts$',
    },
    // 让 .ts/.tsx 的 import/export 也进依赖图（否则 TS 单仓等于空跑）。
    // 为什么用 SWC 而不是 TypeScript 编译器：本仓的 `typescript` = 7.0.2（原生 tsc，
    // JS 包只剩版本号，没有 transpileModule/createProgram）⇒ dependency-cruiser 的默认
    // tsc 解析器会**静默跳过全部 .ts/.tsx**（实测只扫到 13 个 .mjs）。SWC 是独立解析器，
    // 与本仓 TypeScript 7 编译器不冲突。
    parser: 'swc',
    // 只统计运行期 import（`import type` 不计入依赖图）。这样也不会触发
    // dependency-cruiser 的 "missing tsc transpiler" 提示 —— 该提示在本仓是误报
    // （TS 源文件已经由 SWC 解析，只是没有 TS 编译器 API 可用来判 pre-compilation）。
    tsPreCompilationDeps: false,
    combinedDependencies: false,
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
}
