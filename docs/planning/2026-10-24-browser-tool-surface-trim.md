# 内置浏览器工具面收敛（2026-10-24）

## 背景

模型侧工具面一度是 **40 个工具**（+ opt-in 的 `browser_run` = 41），仅工具描述就
10,226 字符（约 3–4k tokens），加上每个工具 10–20 个参数 schema，整体占用约 8–12k
tokens。收益最大的收敛方式不是删能力，而是**合并同义动作 + 低频能力默认不注册**。

## 做了什么

### 1. 合并 7 个工具（能力全部保留，参数变体表达）

| 原工具 | 合并到 | 表达方式 |
| --- | --- | --- |
| `browser_reload` | `browser_navigate` | `direction: 'reload'` |
| `browser_go_back` | `browser_navigate` | `direction: 'back'` |
| `browser_go_forward` | `browser_navigate` | `direction: 'forward'` |
| `browser_dblclick` | `browser_click` | `clickCount: 2`（仍发两对 press/release） |
| `browser_hotkey` | `browser_press` | `keys: ["Control","A"]`（按下序/松开逆序、应用快捷键仍拒） |
| `browser_downloads_list` | `browser_download` | `action: 'list'`（含 `wait`/`status`/`limit`） |
| `browser_downloads_remove` | `browser_download` | `action: 'remove'` + `id` |

`browser_download` 归入 **write** 组（原来是 artifacts 组）。

### 2. 低频能力默认不注册（组保留，显式开启即恢复）

新增/调整 `GROUP_OF`：

- `memory`（默认关）：`bookmarks_add/list/remove`、`history_search`
- `human`（默认关）：`takeover`、`fill_credentials`、`credentials_list`
- `advanced`（默认关）：`drag`、`emulate`
- 默认组 = `navigate`、`interact`、`read`、`write`、`control`（`script` = `browser_run` 仍 opt-in）

运维通过 `Config.toolGroups` 显式打开：`['navigate','interact','read','write','control','memory','human','advanced']`。
缺键 = 默认组（唯一 fail-open 缺省），显式 `[]` = 全关（语义未变）。

### 3. 结果

- 定义总数：41 → **33**（含 `browser_run`）；默认注册面：40 → **24**
- 默认面被砍掉 16 个工具（7 合并 + 9 低频），上下文显著缩小，能力通过参数/组开关仍可达

## 判据与测试

- `tools-interaction-verdicts.spec.ts`：全量注册 = 33、默认 = 24、control 组集合、`browser_run` 34（含 script）
- `audit-0916-user-gate.spec.ts`：注册预算表按新工具面逐个登记
- `audit-c3-deadline-budget-funnel.spec.ts`：等待腿登记表同步（`browser_navigate` 的 load 腿覆盖 back/forward/reload）
- `audit-r22-tool-groups-production.spec.ts`：schema 缺省 → 24；显式组按字面生效
- 新增 `tests/helpers/all-groups.ts`：需要低频组的审计用例统一注册"全部组"

## 兼容性说明

- 工具名删除是**破坏性变更**（模型侧提示词/系统提示若点名旧工具需同步）；运行期内部方法
  `reload/goBack/goForward/hotkey/downloads/removeDownload` 全部保留，op-log 名称不变。
- `browser_run` 的 helper 名称同步收敛：`navigation.direction`、`click({clickCount})`、
  `press({keys})`、`download({action})`；`back/forward/reload/dblclick/hotkey/downloads`
  六个 helper 名已删除。
