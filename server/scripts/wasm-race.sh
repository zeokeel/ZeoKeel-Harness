#!/usr/bin/env bash
# WASM 平台并发关键包的 `-race`（2026-10-23 生产化门禁）。
#
# 为什么单独成脚本而不是把 `go test` 直接写进 Makefile：`scripts/verify-ci-scripts.mjs`
# 要求 Makefile 里每条 `go test` 的包集合等于 `GO_DIRS` 派生集合（防止"注释说与 CI 同义、
# 命令却缩小扫描面"）。本目标**故意**只跑并发最关键的包 + 真删/restore 定向用例，属于
# 已登记的窄集合门禁，不是全量扫描面的替代 —— 放在脚本里让那条判据仍只约束全量面。
#
# 覆盖：
#   - queue / applimits / readyz：准入计数、按应用覆盖、预算账本（锁内/并发读）；
#   - serverstore：两阶段真删 + restore 的并发用例（全包 -race 太慢）。
set -euo pipefail
cd "$(dirname "$0")/.."
TAGS="${1:-}"
GO_TAGS=()
if [[ -n "$TAGS" ]]; then
  # shellcheck disable=SC2206
  GO_TAGS=($TAGS)
fi
go test "${GO_TAGS[@]}" -race ./internal/wasmapp/queue/ ./internal/wasmapp/applimits/ ./internal/wasmapp/readyz/ -count=1
go test "${GO_TAGS[@]}" -race ./internal/serverstore/ \
  -run 'TestBeginWasmAppPurge|TestBeginPurge|TestPurgeVsRestore|TestPurgeCleanup|TestMigration0088|TestMigration0089' \
  -count=1
