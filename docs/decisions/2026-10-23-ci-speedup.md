# 2026-10-23 CI 提速：go test 并行化 + webadmin 变体矩阵拆分

## 背景

CI 的墙钟时间由 `server` job 决定（≈35–39 min happy path），而它的大头是两段**串行**工作：

1. `go test ./... -p 1 -timeout 15m` 全量 ≈26 min；
2. webadmin 变体矩阵（4 个非缺省变体各跑一遍完整单测 ≈5.5 min）+ 产物级判据（5 次真
   vite build ≈1 min），合计 ≈6.4 min。

两段都带着"当年为什么不并行"的注释，但那两条理由**都已经过期**：

- `-p 1` 的理由是 PG 容器 `max_connections` 只有默认 100；而 server job 的
  `Start PostgreSQL` 步骤**早已**用 `postgres -c max_connections=500` 启动（注释自己写着
  "多测试包+serverstore 池 400 会击穿 PG 默认 100"）。
- "变体矩阵不拆 job"的理由是"拆出去要再装一遍 webadmin 依赖"；实际上 `setup-node` 的
  npm cache 命中时 `npm ci` 只需 ≈20–40s，而这两条判据在 server job 里是串行 6.4 min。

## 改造

### 1) `go test -p 4 -timeout 25m`

- 改的是**生成器** `scripts/gen-module-contract.mjs`（ci.yml 的 go test 行是
  `@generated:module-contract` 生成区），再 `node scripts/gen-module-contract.mjs` 重生成。
- **连接数不是约束**：本地同一套测试在 `max_connections=100` 的 PG 容器上用 `-p 4` 全量跑
  通过（本机实测），CI 容器是 500。
- **超时跟本地同值 25m**：`-p 4` 下最慢单包的 wall 会膨胀（实测 250s→625s，见
  `server/Makefile` 的 F3-5 段落）；15m 只剩 1.44× 余量 ⇒ 取 25m。
- server job 预算 60 → **75**：满足 `[SK-7b]` 的 `2×25+14 = 64 ≤ 75`；
  `CI_JOB_BUDGET_MINUTES` 登记同步（改回 60 即红）。
- 自检夹具同步到新真值：默认 job 预算 75、`b1` 显式 60（保持"超时序关系"红样）、
  `b14` 用 65（满足 64 的序关系但低于登记值 75，保持"低于登记值"语义）。

### 2) webadmin 变体矩阵拆成独立 job `webadmin-variants`

- 新 job：`needs: changes`、docs-only fail-safe 形态、`runs-on: ubuntu-24.04`、
  `permissions: { contents: read }`、`timeout-minutes: 30`、
  `defaults.run.working-directory: server`；
  步骤 = checkout → setup-node（npm cache）→ `npm ci --ignore-scripts`（cwd `server/webadmin`）
  → `make webadmin-variant-tests` → `make webadmin-check-features`。
- server job 里那两条步骤删掉，happy path 少 ≈6.4 min。
- 守卫登记（新增 job 必须显式回答"跑在谁的机器上 / 什么权限 / 判据在哪"）：
  `REGISTERED_JOBS`、`REQUIRED_CI_STEPS`（两条的 `job` 改成 `webadmin-variants`）、
  `PINNED_JOB_PERMISSIONS_REGISTRY`、`PINNED_JOB_RUNS_ON_REGISTRY`、
  `PINNED_JOB_WORKING_DIRECTORY_REGISTRY`；两条 `PINNED_STEP_POLICIES` 的识别面改成
  "server ∪ webadmin-variants"。
- `verify-ci-scripts.mjs` 的"CI 必须调度两个变体目标"判据从"server job"改成
  "server ∪ webadmin-variants 任一 job"（否则拆 job 与删步骤在这条判据上同形）。

## 预期效果（4 vCPU 托管 runner）

| 段 | 改造前 | 改造后 |
| --- | --- | --- |
| `go test` 全量 | ≈26 min（-p 1） | **≈17 min**（-p 4，按实测加速比 1.5×） |
| webadmin 变体判据 | 串行 ≈6.4 min（在 server job 内） | ≈7–8 min，**与 go test 并行**（独立 job） |
| server job happy path | ≈35–39 min | **≈24–25 min** |
| job 预算 | 60 min | 75 min（`2×25+14 = 64 ≤ 75`） |

CI 的墙钟 ≈ max(gate, server) ⇒ 预计从 ≈35 min 降到 **≈25 min**。

## 风险 / 认账

- `-p 4` 下最慢单包的 wall 膨胀是真的（625s 实测）：超时取 25m 留 2.4× 余量；单包预算与
  job 预算的序关系由 `[SK-7b]` 守着。
- 真挂的 job 现在要到 75 min 才被取消（此前 60）：但单包 `-timeout 25m` 会先到点并打出
  goroutine dump + 用例名，这正是 R2-SK-7 要的形态。
- 拆 job 后 CI 多一个 job（并发配额内），webadmin 依赖要再装一次（cache 命中 ≈20–40s）。

## 评估后**没做**的两项（附依据）

1. **gate 里那几条"固定守卫开销"（`check:ci-scripts` 67s / `dsh-memory-evolve` 44s /
   `check:integration-tests` 20s / `check:wasm-client-only` 17s）不值得为 CI 单独优化**：
   它们在编排器里与 **desktop 阶段（91s）并行**跑（`check-workspaces` 阶段 1），最长的一条
   67s 也短于 desktop 的 91s ⇒ **不在关键路径上**，压它们不会缩短 gate 的墙钟。真要压，
   得先让 gate 阶段本身变短（那是 vitest 与 8 个 `verify:*` 的事，不是编译器）。
2. **打包 job 的 install/缓存已经到位**：`server` job 的 `actions/setup-go@v7` 自带
   `GOCACHE`/`GOMODCACHE` 缓存；三个 desktop job 与 gate 都缓存 `.yarn/cache` +
   `~/.cache/electron` + `~/.cache/electron-builder`（`key` 按 `yarn.lock` 哈希）。再叠一层
   `node_modules` 缓存会把"缓存命中但树不完整"的失败形态引进来，收益（≈20–30s）小于风险。

## 验证

- `check:workflows` / `check:ci-scripts` / `gen-module-contract --check` / `check:doc-claims` /
  `check:inventories` 全绿（本轮实测）。
- 本地 `make test-server`（同一组 `-p 4` 参数）在 `max_connections=100` 的 PG 上全量通过。

## 首个真实 CI 跑（2026-10-23，PR #1，`beed158f`）

对照 = 同一分支上一个提交 `e7151871` 的两次线上跑。两次都是 push + pull_request 各一条，
所有 job 全绿。

| 指标 | 改前（`e7151871`） | 改后（`beed158f`） | 变化 |
| --- | --- | --- | --- |
| **整条 CI 墙钟** | 25 / 26 min | **16 min** | **−9~10 min（−38%）** |
| `Go server` job | 23 / 24 min | **9 min** | **−14~15 min** |
| `Gate (tests + workspace build)` | 6 min | 5 min | −1 min |
| `Webadmin feature variants`（新 job） | —（原来在 server 里串行 6.4 min） | **5 min，与 go test 并行** | 关键路径 −6.4 min |
| `Gate (root guards)` / 三个 desktop job | 1–2 / 3–10 min | 同左 | 不变 |

比预测的"≈25 min"还好，原因：`-p 4` 之外，变体矩阵搬出 server job（−6.4 min）与 TS7 的
webadmin 构建（−10s）叠加；server job 的 go test 段从 ≈26 min 落到 ≈7–8 min
（4 vCPU 上 `-p 4` 的加速比对这套测试比文档里的 1.5× 更接近 2.5×）。

**新的瓶颈已经不是服务端**：`desktop-linux`（打包 + 平台验证 + `e2e:client`）≈10 min，
串在 gate（5 min）之后 ⇒ 整条 CI 的墙钟现在由它决定。下一步若要继续压 CI，应从这里下手
（打包缓存 / e2e 与打包解耦），而不是继续动 Go。
