# 测试与探针（怎么证明"真的好了"）

> 原则：**存在性断言是假绿**。能点开不等于能用；能渲染不等于链路通。
> 本仓的判据按"离用户多近"分层，越靠近用户的越贵、越不进内循环。

## 1. 测试金字塔（本仓实际形态）

| 层 | 工具 | 在哪跑 | 覆盖什么 |
| --- | --- | --- | --- |
| 单元/集成 | `vitest`（每包） | `yarn check` / `--only <pkg>` | 纯函数、状态机、路由表、构造/解析 |
| 包门禁 | 各包 `check` 脚本 | `scripts/check-workspaces.mjs` | tsc/tsdown 构建 + 该包测试 + 静态断言 |
| 根守卫 | 20 条 `check:*` | `yarn check` / `check-root-guards` | 跨仓不变量（域名、迁移、布局、清单、文档数字…） |
| 客户端 E2E | `e2e:client` 等 | CI `desktop-linux` / 本地按需 | 每个客户端界面 + 错误监控链路 |
| 真机/真服务 | `e2e:real` | 手动（有真实服务时） | 登录、bootstrap、真实网关 |
| 变异自证 | 手工 / `temp/audit/*-mutations.json` | 修复轮 | 证明"修掉实现，用例必须变红" |

## 2. TS 单元/集成

```bash
# 单包
node scripts/check-workspaces.mjs --only dsh-plugin-desktop
# 单文件
corepack yarn workspace dsh-plugin-desktop vitest run tests/<x>.spec.ts
# 全量（提交前）
corepack yarn check          # 37 任务、~300s
corepack yarn check:fast     # 只跑改动影响的包
```

写测试的纪律：

- 断言**行为**（返回值/状态/可观察副作用），不断言实现细节（内部调用次数、私有字段）；
- 期望值来自**独立 oracle**（契约、fixtures、外部记录），不要让实现者顺手改期望；
- 修 bug 先写**会失败的用例**，再做修复；修复后回退实现，确认用例变红（变异自证）；
- 跨端/跨包一致性用 parity 用例（同一语义两处实现时，用同一组用例同时压两处）。

## 3. Go 测试

```bash
cd server
make test-server-fast     # 内循环（命中缓存）
make check-fast           # gofmt + vet + test（缓存命中）+ webadmin 单测
make check                # 全量（含 webadmin 变体矩阵，分钟级）
go test ./internal/<pkg>/... -run <Name> -count=1   # 单用例
```

- DB 用例走**模板库克隆**（`internal/serverstore/dbtest.go`，每用例 ~0.1s）：
  同一个 `PG_DSN_TEST` 才能命中 `go test` 结果缓存；
- `-count=1` 只用于门禁（`make test-server`），内循环不要加；
- 并发/时序类断言用**有预算的轮询**，不要 `time.Sleep` 固定值（CI `-p 4` 下会偶发）。

## 4. 客户端 E2E

### 4.1 `e2e:client`（官方客户端全面板）

```bash
corepack yarn workspace dsh-plugin-desktop e2e:client
```

- 需要**打包产物** + Xvfb（`:99`）+ 可写 `HOME`（`/root/.config` 只读时 singleton lock 会失败；
  用 `HOME=/tmp/... XDG_CONFIG_HOME=... DSH_HOME=...`）；
- 起 mock 网关（`e2e-fixture-gateway.mjs`，端口 34567），路由表见脚本头注释；
- 通过 CDP（`--remote-debugging-port=9223`）驱动，断言登录、侧栏、连接器、技能、设置、自动化面板、
  聊天输入、高级模式、workspace 选择、账户页；
- 产出 `packages/host/desktop/.e2e-report.md` + `.e2e-shots/`；
  **断言条数不写死**，唯一真源是报告首行「结果：N/N 通过」；
- 含两条真实链路断言：错误监控（Sentry 兼容摄取账本严格大于登录前基线）与
  渲染进程未捕获错误（页面主世界真抛一个错误，断言账本出现带 `zeokeel.process=renderer`
  tag 且含本次一次性 marker 的事件）。

### 4.2 聚焦探针（结构断言的补充）

- `e2e:sidebar`：官方右侧栏展开/面板渲染/分栏/标题栏保留带 → `.e2e-sidebar/`
- `e2e:terminal`：新建终端 → xterm 表面 → 真敲 `echo` 断言回显 → `.e2e-terminal/`
- 两者都需要打包产物 + Xvfb，**不在 `yarn check` 内**；改右栏/终端后手动跑。

### 4.3 `e2e:real`（真实服务）

```bash
REAL_SERVER=<url> REAL_USER=<user> REAL_PASS=<pass> \
  corepack yarn workspace dsh-plugin-desktop e2e:real
```

产出 `.real-env-report.md` + `.real-env-shots/`。凭据只从环境变量来，**不得写进仓库**。

### 4.4 打包构建的调试开关（安全边界，不要当成可绕）

- JS 门（`packages/host/desktop/src/debug-switches.ts` + `src/main.ts` 模块级拒绝）覆盖
  `--remote-debugging-port|pipe`、`--js-flags`（单/双横线都算）——CDP 形态会把
  HttpOnly `dsh-auth-*` cookie 交给本机进程。
- `--inspect*` 家族**不归 JS 门管**（`--inspect-brk` 在主脚本运行前就挂起 V8），由打包期
  Electron fuse `EnableNodeCliInspectArguments=false`（`afterPack` 钩子）在 argv 解析期丢弃；
  该 fuse 不影响 `--remote-debugging-port`、`--js-flags` 与开发态（`yarn dev`）。
- `ZEOKEEL_ALLOW_DEBUG_SWITCHES=1` 是**自动化放行**（六个启动器设置），不是安全边界；
  同机同用户威胁模型下攻击者同时控制 argv 与环境。
- 手工 CDP：`fetch('http://127.0.0.1:9223/json/list')` 拿 page target，再走 WebSocket
  `Runtime.evaluate`。
- 杀进程：`pkill -9 -f "dist/linux-unpacked/[d]sh-plugin-desktop"`（方括号技巧；
  直接 `pkill -f electron` 会匹配调用它的 shell 并挂住）。

## 5. 反假绿清单（改测试前先看）

1. "元素存在" ≠ "功能可用"；"接口 200" ≠ "语义正确"；
2. 测试通过但**回退实现仍通过** ⇒ 测试没锁住任何东西（做一次变异）；
3. 让 agent 同时改实现与期望值 ⇒ 同一个误解进两边（期望值必须外部化）；
4. 用 `--update-snapshots`/放宽断言换绿 ⇒ 等于删判据，必须单独评审；
5. CI 上偶发失败不要用 `retry` 掩盖：先定位（时序/共享状态/缓存），再加预算或隔离。
