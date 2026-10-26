/**
 * 能力中心**宿主路由**判据（F-30 / F-32 / F-54，2026-10-26 盘点）。
 *
 * 这些行为只有跑真路由才看得出来，而它们此前只被 enterprise 的跨包用例间接覆盖
 * （那套用例要拉整棵 auth-gate 组合）。本文件直接用 `createSkillRoutes` +
 * 假 fence 跑**真 handler**（真打包/真预检/真 provenance 写入），钉三件事：
 *
 *  1. **F-30**：员工面 `/agent-presets/:name/archive` 两渠道都服务，宿主判不出渠道
 *     ⇒ 面板用 `?channel=market|org` 提示，宿主写进 provenance。修前恒记 `org`，
 *     市场智能体在「我的」里显示成「组织」。
 *  2. **F-32**：`?preview=1` 只打包 + 跑本地预检、**不出网**，回执带"将发布的版本"
 *     （技能取 SKILL.md frontmatter，智能体取 preset.yml —— 服务端同样以包内为准）。
 *  3. **F-54**：`/capabilities` 回执带宿主的只读事实（`auditor`），面板据此隐藏
 *     写按钮（判定只有一份实现 = fence 的 `writeGuard`）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createSkillRoutes, resolveInstallChannel, type HostLocalRouteFence, type SkillRoute } from '../src/host/skill-routes.ts'
import { readProvenance } from '../src/host/skill-install.ts'
import type { Session } from '@zeokeel/dsh-gateway-client/config'

const SKILL_MD = `---
name: codeql
title: CodeQL 示例技能
version: 1.4.0
description: 用于能力中心宿主路由回归测试的示例技能,描述长度足以通过发布前预检。
author: tester
category: security
---
本技能只用于自动化回归测试,不会执行任何静态分析任务;正文刻意写长以通过发布前预检的
正文长度下限要求,内容本身没有任何实际用途,仅用于验证宿主预检与渠道提示这两条链路。
`

const PRESET_YML = `name: 我的智能体
version: 2.3.0
description: 用于能力中心宿主路由回归测试的示例预设,描述长度足以通过发布前预检。
author: tester
category: writing
`

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'alice',
  token: 'USER-TOKEN-abc',
  role: 'employee',
}

interface Captured {
  code: number
  body: any
}

interface Harness {
  routes: SkillRoute[]
  call: (url: string, body?: unknown, method?: 'GET' | 'POST') => Promise<Captured>
  fetchMock: ReturnType<typeof vi.fn>
}

/**
 * 装一套真路由：ctx 只给 logger/get（与桌面最小形状一致），fence 的闸门一律放行，
 * `json` 直接写进可读对象（不必造 ServerResponse 流）。
 */
function harness(options: { writeGuard?: boolean, session?: Session | null } = {}): Harness {
  const writeGuard = options.writeGuard ?? true
  const session = options.session === undefined ? SESSION : options.session
  const fetchMock = vi.fn()
  fetchMock.mockImplementation(async () => { throw new Error('network is disabled in this test') })
  vi.stubGlobal('fetch', fetchMock)

  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    get: () => undefined,
  } as unknown as Context

  let captured: Captured = { code: 0, body: undefined }
  const fence: HostLocalRouteFence = {
    guard: () => true,
    requireWriteProof: () => true,
    writeGuard: () => writeGuard,
    session: () => session,
    json: ((_res: ServerResponse, code: number, body: unknown) => { captured = { code, body } }) as HostLocalRouteFence['json'],
    collectBody: async (req) => (req as unknown as { __body?: Buffer }).__body ?? Buffer.alloc(0),
    readBodyLimited: async (body) => {
      if (body === null) throw new Error('no body')
      const chunks: Uint8Array[] = []
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) chunks.push(value)
      }
      return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
    },
    hostLocale: () => 'zh',
    gatewayError: ((_res: ServerResponse, cause: unknown) => {
      captured = { code: 502, body: { error: `gateway error: ${cause instanceof Error ? cause.message : String(cause)}` } }
    }) as HostLocalRouteFence['gatewayError'],
    passwordChangeRequired: ((_res: ServerResponse, message: string) => { captured = { code: 403, body: { error: message } } }) as HostLocalRouteFence['passwordChangeRequired'],
    clearSessionIfCurrent: () => {},
  }

  const routes = createSkillRoutes(ctx, fence)
  return {
    routes,
    fetchMock,
    call: async (url: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<Captured> => {
      const route = routes.find(candidate => url.startsWith(candidate.path))
      if (route === undefined) throw new Error(`no route for ${url}`)
      captured = { code: 0, body: undefined }
      const req = {
        method,
        url,
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
        ...body === undefined ? {} : { __body: Buffer.from(JSON.stringify(body), 'utf8') },
      } as unknown as IncomingMessage
      await route.handler(req, {} as ServerResponse)
      return captured
    },
  }
}

/** 一份合法的最小预设归档（安装器只要求根上有 agent.cordis.yml）。 */
function presetArchive(): Buffer {
  const zip = new AdmZip()
  zip.addFile('agent.cordis.yml', Buffer.from('name: my-agent\n', 'utf8'))
  zip.addFile('preset.yml', Buffer.from(PRESET_YML, 'utf8'))
  return zip.toBuffer()
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zeokeel-cap-routes-home-'))
  await mkdir(join(home, 'skills', 'codeql'), { recursive: true })
  await writeFile(join(home, 'skills', 'codeql', 'SKILL.md'), SKILL_MD, 'utf8')
  await mkdir(join(home, '.agent-presets', 'my-agent'), { recursive: true })
  await writeFile(join(home, '.agent-presets', 'my-agent', 'agent.cordis.yml'), 'name: my-agent\n', 'utf8')
  await writeFile(join(home, '.agent-presets', 'my-agent', 'preset.yml'), PRESET_YML, 'utf8')
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('F-30 智能体安装的渠道提示（provenance 不再恒 org）', () => {
  it('resolveInstallChannel：只认白名单字面值，其余回落 org（历史行为）', () => {
    expect(resolveInstallChannel('market')).toBe('market')
    expect(resolveInstallChannel('org')).toBe('org')
    expect(resolveInstallChannel(null)).toBe('org')
    expect(resolveInstallChannel('MARKET')).toBe('org')
    expect(resolveInstallChannel('bogus')).toBe('org')
  })

  // 夹具目录已存在（预览用例要用的本机预设）⇒ 安装必须带用户确认标记
  // （`?overwrite=1`，与面板确认条同一条契约）；渠道提示与它正交。
  for (const [query, expected] of [['?channel=market&overwrite=1', 'market'], ['?overwrite=1', 'org'], ['?channel=bogus&overwrite=1', 'org']] as const) {
    it(`安装请求 ${query} ⇒ provenance channel=${expected}`, async () => {
      const h = harness()
      h.fetchMock.mockImplementation(async () => new Response(presetArchive(), {
        status: 200,
        headers: { 'content-type': 'application/zip', 'x-preset-version': '2.3.0' },
      }))
      const res = await h.call(`/api/zeokeel/agent-presets/my-agent/install${query}`)
      expect(res.code).toBe(200)
      const prov = await readProvenance(join(home, '.agent-presets', 'my-agent'))
      expect(prov?.channel).toBe(expected)
      // 版本仍然来自归档响应头（与渠道无关，口径不变）。
      expect(prov?.version).toBe('2.3.0')
    })
  }
})

describe('F-32 上传预检（?preview=1）：回执带将发布版本且不出网', () => {
  it('技能：版本取自 SKILL.md frontmatter，预检不调网关', async () => {
    const h = harness()
    const res = await h.call('/api/zeokeel/shared-skills/upload?preview=1', { name: 'codeql' })
    expect(res.code).toBe(200)
    expect(res.body.preview).toMatchObject({ name: 'codeql', version: '1.4.0' })
    // 关键：预览**只**打包 + 本地预检，绝不发上传请求（否则"确认"就是假的）。
    expect(h.fetchMock).not.toHaveBeenCalled()
  })

  it('智能体：版本取自包内 preset.yml（服务端同样以包内为准）', async () => {
    const h = harness()
    const res = await h.call('/api/zeokeel/agent-presets/upload?preview=1', { name: 'my-agent' })
    expect(res.code).toBe(200)
    expect(res.body.preview).toMatchObject({ name: 'my-agent', version: '2.3.0', displayName: '我的智能体' })
    expect(h.fetchMock).not.toHaveBeenCalled()
  })

  it('预检失败（缺 SKILL.md）⇒ 422 + 可读文案，不发出上传请求', async () => {
    const h = harness()
    const res = await h.call('/api/zeokeel/shared-skills/upload?preview=1', { name: 'missing-skill' })
    expect(res.code).toBe(422)
    expect(String(res.body.error)).toContain('SKILL.md')
    expect(h.fetchMock).not.toHaveBeenCalled()
  })
})

describe('F-54 只读事实：auditor 由 fence 判定、随目录回执下发', () => {
  async function catalog(writeGuard: boolean): Promise<Captured> {
    const h = harness({ writeGuard })
    h.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    return h.call('/api/zeokeel/capabilities?source=own', undefined, 'GET')
  }

  it('auditor（writeGuard=false）⇒ auditor:true；正常账号 ⇒ auditor:false', async () => {
    expect((await catalog(false)).body.auditor).toBe(true)
    expect((await catalog(true)).body.auditor).toBe(false)
  })

  it('面板能读到的字段是布尔值（undefined 会被渲染层当成"旧宿主"，不得下发字符串）', async () => {
    const body = (await catalog(false)).body as { auditor?: unknown }
    expect(typeof body.auditor).toBe('boolean')
  })
})
