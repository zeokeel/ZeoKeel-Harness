import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorDef } from '../src/types.ts'
import { parseServerConnectors } from '../src/index.ts'
import { trySilentAuth } from '../src/silent-auth.ts'
import { outboundFetch } from '../src/outbound.ts'

vi.mock('../src/outbound.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/outbound.ts')>()
  return { ...actual, outboundFetch: vi.fn() }
})

const TOKEN_URL = 'https://rbac.example.com/oauth2/token'
const MCP_URL = 'https://rbac.example.com/mcp'

function def(overrides: Partial<ConnectorDef> = {}): ConnectorDef {
  return {
    id: 'hr-data',
    name: 'hr',
    description: '',
    authMode: 'oauth',
    auth: {
      authorizeUrl: 'https://rbac.example.com/oauth2/authorize',
      tokenUrl: TOKEN_URL,
      clientId: '',
      redirectUri: 'http://127.0.0.1/callback',
      scopes: 'mcp.read',
    },
    mcp: [{ serverName: 'hr', transport: 'streamable-http', url: MCP_URL }],
    ...overrides,
  } as ConnectorDef
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('silent connector authorization', () => {
  beforeEach(() => {
    vi.mocked(outboundFetch).mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exchanges a server assertion for the current user credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      assertion: 'header.payload.signature',
      token_endpoint: TOKEN_URL,
      client_id: 'zeokeel-connector',
      scope: 'mcp.read',
      resource: MCP_URL,
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(outboundFetch).mockResolvedValue(jsonResponse({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
    }))

    const patch = await trySilentAuth(def(), {
      session: { serverURL: 'https://server.example.com', token: 'session-token', username: 'user-a' },
      locale: 'zh',
      username: 'user-a',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://server.example.com/api/client/v2/connectors/hr-data/assertion',
      expect.objectContaining({ method: 'POST' }),
    )
    const [url, , init, fetchOptions] = vi.mocked(outboundFetch).mock.calls[0] ?? []
    expect(url).toBe(TOKEN_URL)
    expect(init?.method).toBe('POST')
    const form = init?.body as URLSearchParams
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
    expect(form.get('subject_token')).toBe('header.payload.signature')
    expect(form.get('client_id')).toBe('zeokeel-connector')
    expect(form.get('scope')).toBe('mcp.read')
    expect(form.get('resource')).toBe(MCP_URL)
    expect(fetchOptions).toEqual(expect.objectContaining({ locale: 'zh' }))
    expect(patch).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      clientId: 'zeokeel-connector',
      account: 'user-a',
    })
    expect(patch?.expiresAt).toBeTypeOf('number')
  })

  it('refuses a token endpoint different from the definition authority', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      assertion: 'a.b.c',
      token_endpoint: 'https://evil.example.com/oauth2/token',
      client_id: 'zeokeel-connector',
      scope: 'mcp.read',
      resource: MCP_URL,
    })))

    const patch = await trySilentAuth(def(), {
      session: { serverURL: 'https://server.example.com', token: 'session-token' },
      locale: 'zh',
    })

    expect(patch).toBeNull()
    expect(outboundFetch).not.toHaveBeenCalled()
  })

  it('returns null without a session or for a rejected assertion', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await trySilentAuth(def(), { session: null, locale: 'zh' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValue(new Response('no', { status: 401 }))
    expect(await trySilentAuth(def(), {
      session: { serverURL: 'https://server.example.com', token: 'session-token' },
      locale: 'zh',
    })).toBeNull()
  })

  it('does not attempt anything for a definition without a token endpoint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const noAuth = def({ auth: undefined })

    expect(await trySilentAuth(noAuth, {
      session: { serverURL: 'https://server.example.com', token: 'session-token' },
      locale: 'zh',
    })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('server catalog auto-auth fields', () => {
  it('parses auto_auth/auto_connect without losing the definition', () => {
    const [parsed] = parseServerConnectors([{
      id: 'hr-data',
      name: 'hr',
      description: '',
      auth_mode: 'oauth',
      definition: JSON.stringify({
        auth: { tokenUrl: TOKEN_URL, authorizeUrl: 'https://rbac.example.com/oauth2/authorize', scopes: 'mcp.read' },
        mcp: [{ serverName: 'hr', transport: 'streamable-http', url: MCP_URL }],
      }),
      auto_auth: 'rbac-assertion',
      auto_connect: true,
    }])

    expect(parsed?.autoAuth).toBe('rbac-assertion')
    expect(parsed?.autoConnect).toBe(true)
    expect(parsed?.mcp[0]?.url).toBe(MCP_URL)
  })

  it('ignores an unknown auto_auth value', () => {
    const [parsed] = parseServerConnectors([{
      id: 'hr-data',
      name: 'hr',
      description: '',
      auth_mode: 'oauth',
      definition: JSON.stringify({ auth: { tokenUrl: TOKEN_URL }, mcp: [{ serverName: 'hr', transport: 'streamable-http', url: MCP_URL }] }),
      auto_auth: 'something-else',
    }])
    expect(parsed?.autoAuth).toBeUndefined()
    expect(parsed?.autoConnect).toBeUndefined()
  })
})
