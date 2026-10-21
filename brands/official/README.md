# brands/official — 官方品牌文件夹（唯一事实源）

本目录是 ZeoKeel Harness 官方渠道的品牌**唯一事实源**。所有 logo 图形、图标、品牌文案一律从本目录派生；禁止在仓库其他地方维护/编造品牌资产。

## 目录内容

| 文件 | 说明 |
|---|---|
| `logo.svg` | 权威主 logo：白色圆角方块（1254² rx=180 `#FFFFFF`）+ 彩色渐变波浪标记（1 圆点 + 6 条路径 + 6 条 linearGradient）。浅色/日常主题、默认场景使用。 |
| `logo-dark.svg` | 权威暗色 logo：黑色圆角方块（`#000000`）+ **同一彩色标记**。**标记几何与颜色完全一致，只有方块底色不同**——深色/夜间主题使用（`site`、客户端暗色界面）。 |
| `app-icon.png` | 应用图标权威位图（1024² RGBA16 + ICC，黑底 + 彩色标记）。Windows/Linux 应用图标直接使用；macOS Dock 图标经 `scripts/generate-mac-app-icon.mjs` 派生。 |
| `brand.json` | 品牌配置（schema v1）：identity（名称/app id/版权）、assets（双色 logo/图标）、copy（全部品牌文案，支持 `{product}`/`{version}` 模板）、defaults、updates、sources（每个键→当前源码位置映射，供归一化改造跟踪）。 |
| `assistedMessages.yml` | NSIS 安装器引导文案（3 语言）。 |

## 派生规则（编译阶段）

```
brands/official/ (入库，唯一事实源)
  ├── logo.svg ──────────┬─→ scripts/generate-tray-icons.mjs ─→ build/tray-icon*.png   (mac 模板 + win/linux 托盘)
  │                      └─→ site 官网引用（import brands/official/logo.svg；dark 主题用 logo-dark.svg）
  ├── app-icon.png ──────┬─→ build/app-icon.png 复制 (win/linux 应用图标)
  │                      └─→ scripts/generate-mac-app-icon.mjs ─→ build/app-icon-mac.png (Dock, 824/1024 安全区)
  ├── logo-dark.svg ─────┴─→ 暗色主题 logo（官网/客户端暗色面）
  └── brand.json ────────→ 打包注入 app 资源（运行时读取：标题/文案/更新源/默认配置）
```

- 一个统一入口脚本：`packages/host/desktop/scripts/brand-prepare.mjs`（读取本目录 → 派生输出到 `packages/host/desktop/build/` → 校验），已挂入 `yarn workspace dsh-plugin-desktop build`。
- `packages/host/desktop/build/` 下的图标均为派生产物，**不入库**（见根 `.gitignore`）。
- 派生产物不得手动修改；改图形只改本目录权威源。

## 日/夜双色约定（必须遵守）

- `logo.svg`：**白 tile + 彩色 mark** —— 日常/浅色背景。
- `logo-dark.svg`：**黑 tile + 同一份彩色 mark** —— 深色背景/夜间模式。
- 两文件**标记几何与标记颜色严格一致**，只允许方块底色不同；禁止手绘/改几何。
- 图形本身是**彩色渐变**，不得改成 `currentColor`/单色；唯一例外是 macOS 菜单栏 template —— 构建期由 `generate-tray-icons.mjs` 去掉方块、只取 alpha，系统自动染成黑/白。
- 客户端兜底（登录页/sidebar）使用从 `logo.svg` 去掉方块后的**透明彩色 mark**；服务端门户与 favicon/app icon 使用带方块底的彩色版本（浅色面 logo.svg / 深色面 logo-dark.svg）—— 除 macOS 菜单栏模板外，任何面都不得使用单色/currentColor 图形。

## 渠道化（企业定制）

```
brands/<channel-id>/          # 复制 brands/official/ 后修改：
  ├── logo.svg                #   企业 logo（须方形、有安全边距，SVG 优先）
  ├── logo-dark.svg           #   企业 logo 暗色版（同一 mark、仅换黑/白底）
  ├── app-icon.png            #   1024² RGBA16+ICC（mac 管道要求）
  ├── brand.json              #   channel_id/identity/copy/defaults/updates 改值
  └── assistedMessages.yml    #   安装文案
```

构建时以 `--brand <channel-id>` 选择；`official` 为缺省（与现状完全一致）。

## 官网边界（重要）

**官网只接收官方渠道，其他渠道不需要。**
- `site/`（www.zeokeel.com）是 **official 渠道专属品牌面**：直接 import 本文件夹的 `logo.svg` / `logo-dark.svg`（starlight light/dark 双 logo）。
- 渠道化复制（`brands/<channel-id>/`）**不会**驱动官网；官网永远只读 `brands/official/`——企业渠道的产品面只有安装包与运行时品牌（服务端 brand API），不产出官网/门户站点。
- 若某企业将来也要官网/门户，那属于单独的交付物，走独立管线，不挂在本文件夹的派生链上。
- 因此：不要把 `chains` 里 site 相关项纳入渠道派生；`brand-prepare.mjs` 只服务桌面客户端打包链。

## 校验

```bash
node packages/host/desktop/scripts/brand-prepare.mjs   # 派生 + 校验（素材存在/几何一致）
node packages/host/desktop/scripts/generate-mac-app-icon.mjs --help  # 单步再生
```
