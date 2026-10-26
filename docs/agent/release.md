# CI 与发布（硬规则）

> 细节设计见 `docs/decisions/`：`2026-09-06-ci-pipeline-redesign.md`、
> `2026-09-10-verification-speedup.md`、`2026-10-23-ci-speedup.md`。
> 本文件只保留 agent 必须知道的**不可破坏**条目。

## 1. 触发与产物

- 触发：`pull_request` + `push`（全分支含 tag）。
- 非 docs-only 的提交产出可下载 Artifacts：
  `desktop-Linux`（AppImage；`dist:linux` 会一并构建 `deb`，但归集面只收 AppImage）、
  `desktop-Windows-installer`（NSIS）、`desktop-macOS`（DMG）、`zeokeel-server-linux-amd64`。
- docs-only（只改 `docs/`、`site/`、`*.md`）由 `changes` job 判定：`gate`/`server`/三平台 job
  全跳过 ⇒ **零 artifact**，但 `gate-guards` 照跑（docs-only 的 PR 也执行根守卫）。
  分支首推（`before` 全零）用 `merge-base(origin/master, HEAD)` 作基点；取不到即 fail-safe
  成"有代码改动"。
- 测试只在 PR / master push 上跑；**tag 只编译 + 打包 + 发布**（tag 永远打在已跑过全量 CI 的
  提交上）。tag 上允许跳过的步骤登记在 `scripts/check-workflows.mjs` 的
  `PINNED_STEP_IF_POLICIES['docs-only-and-not-tag']` —— **未登记的任何收窄一律拒**。

## 2. job 结构

`changes`（docs-only 分类器）→ `gate-guards`（**永不跳过**：docs-only 也跑根守卫）
∥ `gate`（ubuntu：`yarn check` 全量门禁 + 一次构建，上传 `workspace-build` =
15 包 `lib/**` + desktop `build/**`）→ `server`（PG 18 容器 + gofmt + vet +
`go test -p 4 -timeout 25m` + webadmin `npm test` + `make build-server`）
∥ `webadmin-variants`（4 个非缺省变体单测 + 5 次 vite 产物判据）
→ `desktop-linux/win/macos`（`needs: gate`，下载 `workspace-build` 恢复后**只做打包 + 平台验证**，
linux 追加 `e2e:client`）→ tag 时 `release`（needs `gate` + 三平台 job）。

## 3. 发布面硬规则

- **Release 名 = tag 本身**（不要加 `ZeoKeel Harness v…` 前缀：Releases 列表会把它截断成 `…v2.6…`）。
- **正式 tag 与预发 tag 都必须有策展发布说明** `docs/releases/<tag>.md`。三道同口径检查：
  `gate` 第一步 / `release` job 首步 / `gh release create` 之前；缺失即失败。
  `--generate-notes` 回退已删除（自动变更日志的正文来自提交信息与 PR 标题/正文，
  那两处不在 `check-no-real-domains` 的判据面内，历史上正是这条路径把真实域名/IP 带进了公开 Release）。
- tag 发布链三条判据：tag 形态唯一真源 `scripts/ci-release-policy.sh`（未知后缀当场红）；
  基线拓扑 `scripts/ci-release-topology.sh`（上一个 tag 不在主线即红）；渠道仓检出 pin
  （`gate` 解析一次 `channels_rev`，四个调用点以 `CI_CHANNELS_PIN` 复用并硬校验）。
- **镜像分发不经任何镜像仓库**：tag 时 `release` job 从源码构建镜像（打进三平台客户端资产 +
  私有渠道仓的渠道内容）→ `docker save | zip` → **同一个 job 内**先上传更新服务器 R2
  （`scripts/ci-publish-update-server.sh`，写 `release.zeokeel.com/<channel>/releases/<v>/`，
  清理到最近 2 个版本）→ 再挂 GitHub Release（**只对 beta/official**，品牌渠道不公开）。
  上传后对三个对象（镜像 zip、`SHA256SUMS`、`latest.json` 指针）逐个做"大小 + SHA256"对拍，
  任一不符即失败且不写指针；判据在 `scripts/verify-ci-scripts.mjs`。

## 4. 打包脚本开关（消除重复编译）

- `--no-prebuild`：跳过 `prebuildWorkspaceDeps`（15 包构建）；
- `--no-gates`：跳过入口内嵌 check（win `check:win-package` / mac smoke 根 check /
  mac release pack 内根 check）；
- 默认（本地 `yarn dist:*`）= prebuild + 内嵌 check + 打包 + 验证；
- 打包后的平台验证（`verify-win-installer` / `verify-mac-smoke` / `verify-mac-release` /
  `afterPack`）**不在跳过范围**。

## 5. 提交前自检（本地等价物）

```bash
corepack yarn check                 # 与 CI gate job 同义
corepack yarn check:ci-parity       # 本地能复现的 CI 步骤（约 3 分钟）
cd server && make check-fast        # 服务端快速门禁
```

`check:ci-parity` 的意义：本地三件套只覆盖 CI 判据面约 12%；它把"能真跑"的 CI 步骤收成
一条可复算的命令，让本地收尾不只靠"看起来绿"。
