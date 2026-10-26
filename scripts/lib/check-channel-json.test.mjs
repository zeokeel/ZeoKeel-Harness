#!/usr/bin/env node
/**
 * 公共渠道品牌素材字节判据的回归用例（2026-10-26 生产事故）。
 *
 * ## 为什么是独立文件 + `node:test`，而不是塞进 `scripts/verify-wasm-channels.mjs`
 *
 * 本仓**没有根级脚本测试框架**（根 `package.json` 的 `test` 只跑两个 workspace 包；
 * `scripts/**` 只有守卫脚本本身），而这条判据住在被 shell 以子进程调用的命令行校验器里。
 * 用 node 内置的 test runner 写成**自包含用例**：可以单跑
 * （`node --test scripts/lib/check-channel-json.test.mjs`），也由**同一个入口**
 * （`scripts/verify-wasm-channels.mjs`）在每位 `yarn check` 里真的跑一次 —— 只存在于
 * 本地手动入口里的判据等于没有判据（本仓的既有教训）。
 *
 * ## 为什么必须是"字节"用例（旧状态先红）
 *
 * 2026-10-21 公开仓换品牌几何后，渠道仓里公共渠道目录的素材仍是**旧几何的字节**；
 * 既有判据只看字段与形状 ⇒ 发布链把旧 mark 带进门户、管理端与客户端，而所有门禁皆绿。
 * 因此第一条用例在**旧状态**（校验器没有字节判据）下必然红：旧校验器对"旧字节 logo"
 * 照样 exit 0。
 *
 * 四个形态（少一条这条判据就会假绿或误伤）：
 *   a. 公共渠道目录里的 logo 与真源字节不同、且**声明**了 `assets.logo`
 *      ⇒ 校验器非 0 退出、点名 `assets.logo` 与期望的真源路径，且不回显渠道侧取值；
 *   a2. 同上但**不声明** `assets.logo`（打包侧仍按文件名消费 logo.svg）⇒ 同样必须非 0；
 *   b. 换成真源的**逐字节副本** ⇒ exit 0（否则修好渠道仓也发不出包）；
 *   c. 品牌渠道带任意 logo 字节 ⇒ exit 0（判据只对 official/beta 生效，不得误伤客户品牌）。
 *
 * 用法：`node --test scripts/lib/check-channel-json.test.mjs`
 * 退出码由 `node:test` 决定（0 = 全部通过）。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** 被测校验器（`ci-channels.sh` 调用的是同一份）。 */
const VALIDATOR = join(ROOT, 'scripts', 'lib', 'check-channel-json.mjs')
/** 品牌几何唯一真源（AGENTS.md）；用例里的"正确字节"直接从这里取。 */
const AUTHORITY = join(ROOT, 'brands', 'official')
/** 打包管线按文件名消费的两件素材（唯一真源 = channel-constants.ts 的 CHANNEL_ASSET_FILES）。 */
const LOGO_FILE = 'logo.svg'
const APP_ICON_FILE = 'app-icon.png'
/**
 * "旧几何"的替身字节：只要与真源**不同**就是本用例要的形态。
 * 刻意不是合法 SVG —— 内容是"旧品牌 mark"这件事对判据没有意义，反而会先被
 * 素材的脚本特征检查拦下，让用例红在另一条判据上（那就测不到字节判据了）。
 */
const STALE_LOGO = Buffer.from('stale-logo-bytes-from-the-old-brand-geometry\n', 'utf8')

/**
 * 校验器依赖的环境变量（与 `ci-channels.sh` 调用点同形）。
 * `CHANNEL_FEATURE_MODULE_LIST` 只需**非空**：本文件不写 `features`，它只用于
 * "功能模块清单没到校验器手里"那条 fail-loud 的前提。
 * @param channelId - 渠道 id（决定 publicChannel 分支）。
 * @returns 合并进 `process.env` 的键值。
 */
function validatorEnv(channelId) {
  return {
    CHANNEL_ID: channelId,
    CHANNEL_LOGO_FILE: LOGO_FILE,
    CHANNEL_APP_ICON_FILE: APP_ICON_FILE,
    CHANNEL_FEATURE_MODULE_LIST: 'skills,apps,connectors',
  }
}

/**
 * 公共渠道（official/beta）的最小合法 channel.json。
 * @param channelId - 渠道 id。
 * @param withLogo - 是否声明 `assets.logo`（公共渠道声明它是可选的，两条路径都要覆盖）。
 * @returns channel.json 内容。
 */
function publicChannelConfig(channelId, withLogo) {
  return {
    schema: 1,
    channel_id: channelId,
    identity: { display_name: 'Official Harness', short_name: 'Official' },
    ...(withLogo ? { assets: { logo: LOGO_FILE } } : {}),
    desktop: { app_origin_scheme: 'zeokeel-app' },
  }
}

/**
 * 品牌渠道（official/beta 之外）的最小合法 channel.json —— 校验器对它还有一堆必填
 * 与形状判据，本文件只关心"字节判据不能套到品牌渠道头上"，所以配置按规则补齐。
 * @param channelId - 渠道 id。
 * @returns channel.json 内容。
 */
function brandChannelConfig(channelId) {
  return {
    schema: 1,
    channel_id: channelId,
    identity: { display_name: 'Example Brand', short_name: 'Example' },
    assets: { logo: LOGO_FILE },
    desktop: {
      product_name: 'Example Brand AI',
      slug: 'example-brand-AI',
      app_id: 'com.example.examplebrand',
      home_dir: '.example-brand-harness',
      deep_link_scheme: 'examplebrandlink',
      app_origin_scheme: 'examplebrand-app',
    },
  }
}

/**
 * 造一个合成渠道目录（`<tmp>/channels/<id>/`）。
 * 非公共渠道顺手拷真源的安装器图标：品牌渠道缺图标会被**另一条**判据拦下，
 * 那与本文件要证的 logo 字节判据无关（用例红在别处 = 测到的东西与声称的不同）。
 * @param channelId - 渠道 id（目录名与 `channel_id` 同值）。
 * @param options - `config` = channel.json 内容；`logoBytes` = 目录里 logo 素材的字节。
 * @returns `{ root, dir }`（`root` 用于用例收尾清理）。
 */
function makeChannelDir(channelId, options) {
  const root = mkdtempSync(join(tmpdir(), 'channel-brand-'))
  const dir = join(root, 'channels', channelId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'channel.json'), JSON.stringify(options.config, null, 2))
  writeFileSync(join(dir, LOGO_FILE), options.logoBytes)
  if (channelId !== 'official' && channelId !== 'beta') {
    copyFileSync(join(AUTHORITY, APP_ICON_FILE), join(dir, APP_ICON_FILE))
  }
  return { root, dir }
}

/**
 * 跑一次校验器（与 shell 调用点同形：`node <校验器> <channel.json>`）。
 * @param channelId - 渠道 id。
 * @param dir - 渠道目录。
 * @returns `{ status, output }`；`output` 是 stdout+stderr 的合并（报错走 stderr）。
 */
function runValidator(channelId, dir) {
  const result = spawnSync(process.execPath, [VALIDATOR, join(dir, 'channel.json')], {
    encoding: 'utf8',
    env: { ...process.env, ...validatorEnv(channelId) },
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** 清理合成目录（失败路径也要清，免得 /tmp 里留一堆积压）。 */
function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

test('公共渠道 + 旧字节 logo（已声明 assets.logo）⇒ 非 0 且点名字段', () => {
  const channel = makeChannelDir('official', {
    config: publicChannelConfig('official', true),
    logoBytes: STALE_LOGO,
  })
  try {
    const run = runValidator('official', channel.dir)
    assert.notEqual(run.status, 0, '旧字节 logo 必须被拦下（旧状态：exit 0 ⇒ 本用例红）')
    assert.ok(run.output.includes('assets.logo'), `报错必须点名 assets.logo，实际输出：\n${run.output}`)
    assert.ok(run.output.includes('brands/official/logo.svg'), '报错必须给出期望的品牌真源路径')
    // 公开仓纪律：报错不得回显渠道侧取值/文件内容。
    assert.ok(!run.output.includes('stale-logo-bytes'), '报错不得回显渠道侧素材内容')
  } finally {
    cleanup(channel.root)
  }
})

test('公共渠道 + 旧字节 logo（未声明 assets.logo，打包侧仍按文件名消费）⇒ 非 0', () => {
  const channel = makeChannelDir('official', {
    config: publicChannelConfig('official', false),
    logoBytes: STALE_LOGO,
  })
  try {
    const run = runValidator('official', channel.dir)
    assert.notEqual(run.status, 0, '未声明但存在的 logo 素材同样会被打包链消费，必须被拦下')
    assert.ok(run.output.includes('assets.logo'), `报错必须点名 assets.logo，实际输出：\n${run.output}`)
  } finally {
    cleanup(channel.root)
  }
})

test('公共渠道 + 真源逐字节副本 ⇒ exit 0', () => {
  const channel = makeChannelDir('official', {
    config: publicChannelConfig('official', true),
    logoBytes: readFileSync(join(AUTHORITY, LOGO_FILE)),
  })
  try {
    const run = runValidator('official', channel.dir)
    assert.equal(run.status, 0, `真源字节必须放行（否则修好渠道仓也发不出包），实际输出：\n${run.output}`)
  } finally {
    cleanup(channel.root)
  }
})

test('品牌渠道 + 任意 logo 字节 ⇒ exit 0（不误伤客户品牌）', () => {
  const channel = makeChannelDir('example-brand', {
    config: brandChannelConfig('example-brand'),
    logoBytes: Buffer.from('customer-owned-brand-geometry\n', 'utf8'),
  })
  try {
    const run = runValidator('example-brand', channel.dir)
    assert.equal(run.status, 0, `品牌渠道的品牌就是客户自己的，字节判据不得套用，实际输出：\n${run.output}`)
  } finally {
    cleanup(channel.root)
  }
})
