/**
 * Regression suite for the SILENT connector authorization and the automatic
 * (session-start) connect built on top of it.
 *
 * These cases assert the REQUIRED behaviour of the feature, not the behaviour a
 * default attempt happens to have:
 *
 *  - a session change cancels an in-flight automatic silent exchange
 *    synchronously — nothing may be exchanged, written or registered after the
 *    logout/user switch, exactly like a manual flow is aborted by teardown;
 *  - an automatic attempt is an optimization: it keeps the actionable
 *    `unauthorized`/`error` verdict the restore pass produced instead of
 *    replacing it with a bare `disconnected`;
 *  - automatic connect is zero-interaction: a definition that still needs a
 *    required pre-connect setting (or a local stdio approval) is skipped, no
 *    form/QR is published and the row is not parked in `connecting`;
 *  - a restored silent credential that cannot renew itself (no refresh token, or
 *    already expired) is re-authorized at startup instead of staying "connected"
 *    forever;
 *  - only a STATIC OAuth definition takes the silent path: an `auto`-mode
 *    definition must not be reported `connected` without a transport provider
 *    (that row would send no Authorization header and every tool call would 401).
 *
 * The token endpoint is a REAL loopback HTTP server (the outbound policy allows
 * loopback http) so the RFC 8693 exchange and the refresh call go through the
 * production `outboundFetch`; only the bootstrap/assertion responses are stubbed
 * on the global `fetch` seam, and `@deepseek-ai/dsh-mcp-client` is replaced by a
 * no-op (the same seam every connector spec uses — the real carrier spawns
 * nothing in these cases).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorDef } from '../src/types.ts'
import {
  callRoute,
  createHarness,
  seedCredential,
} from './helpers/connector-harness.ts'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

const SERVER_URL = 'https://server.example.com'
const MCP_URL = 'https://mcp.example.com/mcp'
const CONNECTOR_ID = 'hr-data'
const ASSERTION = 'header.payload.signature'
const SESSION_TOKEN = 'session-token'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  while (cleanups.length > 0) {
    try { await cleanups.pop()?.() } catch { /* ignore */ }
  }
})

interface TokenServer {
  tokenUrl: string
  authorizeUrl: string
  readonly requests: URLSearchParams[]
  close: () => Promise<void>
}

/** REAL loopback token endpoint for the assertion exchange. */
async function startTokenServer(
  reply: (form: URLSearchParams) => { status: number; body: unknown } = () => ({
    status: 200,
    body: { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 },
  }),
): Promise<TokenServer> {
  const requests: URLSearchParams[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      const form = new URLSearchParams(raw)
      requests.push(form)
      const outcome = reply(form)
      res.writeHead(outcome.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(outcome.body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${String(port)}`
  return {
    tokenUrl: `${base}/oauth2/token`,
    authorizeUrl: `${base}/oauth2/authorize`,
    requests,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

function connectorItem(token: TokenServer, overrides: Record<string, unknown> = {}, definition: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONNECTOR_ID,
    name: 'HR',
    description: '',
    auth_mode: 'oauth',
    definition: JSON.stringify({
      auth: {
        authorizeUrl: token.authorizeUrl,
        tokenUrl: token.tokenUrl,
        clientId: '',
        redirectUri: 'http://127.0.0.1:43123/callback',
        scopes: 'mcp.read',
      },
      mcp: [{ serverName: 'hr', transport: 'streamable-http', url: MCP_URL }],
      ...definition,
    }),
    ...overrides,
  }
}

function assertionResponse(token: TokenServer, overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    assertion: ASSERTION,
    token_endpoint: token.tokenUrl,
    client_id: 'zeokeel-connector',
    scope: 'mcp.read',
    resource: MCP_URL,
    ...overrides,
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface FetchCall { url: string; init: RequestInit | undefined }

/**
 * Stub the global `fetch` used by the bootstrap catalogue sync and the
 * assertion request; everything else (the token exchange, the refresh) goes
 * through `outboundFetch` to the real loopback server above.
 */
function stubFetch(options: {
  bootstrap: unknown
  assertion: (url: string, init: RequestInit | undefined) => Response | Promise<Response>
}): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: unknown }).url ?? input)
    calls.push({ url, init })
    if (url.endsWith('/api/client/v2/config/bootstrap')) return jsonResponse(options.bootstrap)
    if (/\/api\/client\/v2\/connectors\/[^/]+\/assertion$/.test(url)) return await options.assertion(url, init)
    throw new Error(`unexpected fetch in silent-auth test: ${url}`)
  }))
  return calls
}

async function makeHarness(defs: ConnectorDef[] = []): Promise<{
  harness: ReturnType<typeof createHarness>
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'zk-connectors-auto-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  const harness = createHarness(defs, dir, { refreshSweepIntervalMs: 0, requestApproval: () => true })
  cleanups.push(() => { harness.dispose() })
  return { harness, dir }
}

async function listRows(harness: ReturnType<typeof createHarness>): Promise<Array<Record<string, unknown>>> {
  const response = await callRoute(harness, '/api/zeokeel/connectors', 'GET')
  return (JSON.parse(response.body) as { connectors: Array<Record<string, unknown>> }).connectors
}

async function rowOf(harness: ReturnType<typeof createHarness>): Promise<Record<string, unknown> | undefined> {
  return (await listRows(harness)).find(row => row.id === CONNECTOR_ID)
}

async function readCredential(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dir, `${CONNECTOR_ID}.json`), 'utf8')) as Record<string, unknown>
  } catch { return null }
}

function login(harness: ReturnType<typeof createHarness>): void {
  harness.emitSession({ username: 'user-a', serverURL: SERVER_URL, token: SESSION_TOKEN })
}

describe('automatic silent connect', () => {
  it('logs in, exchanges the assertion and registers the connector once', async () => {
    const tokenServer = await startTokenServer()
    cleanups.push(() => tokenServer.close())
    const calls = stubFetch({
      bootstrap: { connectors: [connectorItem(tokenServer, { auto_auth: 'rbac-assertion', auto_connect: true })] },
      assertion: () => assertionResponse(tokenServer),
    })
    const { harness, dir } = await makeHarness()

    login(harness)

    await vi.waitFor(() => {
      expect(tokenServer.requests).toHaveLength(1)
      expect(harness.configs).toHaveLength(1)
    }, { timeout: 10_000 })
    const assertionCall = calls.find(call => call.url.includes('/assertion'))
    expect(assertionCall?.init?.headers).toMatchObject({ Authorization: `Bearer ${SESSION_TOKEN}` })
    expect(assertionCall?.init?.redirect).toBe('error')
    expect(tokenServer.requests[0]?.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
    expect(tokenServer.requests[0]?.get('subject_token')).toBe(ASSERTION)
    expect(await readCredential(dir)).toMatchObject({ accessToken: 'access-1', clientId: 'zeokeel-connector' })
    expect((await rowOf(harness))?.status).toBe('connected')
  })

  it('a session change cancels the in-flight automatic exchange: nothing is written or registered', async () => {
    const tokenServer = await startTokenServer()
    cleanups.push(() => tokenServer.close())
    let assertionSignal: AbortSignal | undefined
    // The assertion request is black-holed — it only settles when the session
    // signal aborts it, the same shape a slow/unreachable gateway produces.
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.endsWith('/api/client/v2/config/bootstrap')) {
        return jsonResponse({ connectors: [connectorItem(tokenServer, { auto_auth: 'rbac-assertion', auto_connect: true })] })
      }
      assertionSignal = init?.signal ?? undefined
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }))
    const { harness, dir } = await makeHarness()

    login(harness)
    await vi.waitFor(() => { expect(assertionSignal).toBeDefined() }, { timeout: 10_000 })
    expect(assertionSignal?.aborted).toBe(false)

    // Logout while the automatic exchange is still waiting on the assertion.
    harness.emitSession(null)

    await vi.waitFor(() => { expect(assertionSignal?.aborted).toBe(true) }, { timeout: 10_000 })
    await vi.waitFor(async () => { expect((await rowOf(harness))?.status).toBe('disconnected') }, { timeout: 10_000 })
    expect(tokenServer.requests).toHaveLength(0)
    expect(harness.configs).toHaveLength(0)
    expect(await readCredential(dir)).toBeNull()
  })

  it('keeps the actionable unauthorized verdict when the automatic attempt fails', async () => {
    // The stored refresh token is revoked: restoreAll reports "authorize again"
    // (unauthorized + auth-required) — the automatic attempt must not erase it.
    const tokenServer = await startTokenServer(() => ({ status: 400, body: { error: 'invalid_grant' } }))
    cleanups.push(() => tokenServer.close())
    stubFetch({
      bootstrap: { connectors: [connectorItem(tokenServer, { auto_auth: 'rbac-assertion', auto_connect: true })] },
      assertion: () => jsonResponse({ error: { code: 'NOT_FOUND' } }, 404),
    })
    const { harness, dir } = await makeHarness()
    await seedCredential(dir, CONNECTOR_ID, {
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh',
      clientId: 'cid',
      expiresAt: Date.now() - 60_000,
      updatedAt: Date.now(),
    })

    login(harness)
    await vi.waitFor(async () => { expect((await rowOf(harness))?.status).toBe('unauthorized') }, { timeout: 10_000 })

    const row = await rowOf(harness)
    expect(row?.status).toBe('unauthorized')
    expect(row?.errorCode).toBe('auth-required')
    expect(typeof row?.error).toBe('string')
    expect(row?.request).toBeNull()
    // Diagnostics: one fixed-shape line, and no assertion/token material leaks.
    const report = harness.warns.find(line => line.includes('silent-auth unavailable'))
    expect(report).toContain(`id=${CONNECTOR_ID}`)
    expect(harness.warns.join('\n')).not.toContain(ASSERTION)
    expect(harness.warns.join('\n')).not.toContain('stale-refresh')
  })

  it('skips a definition that still needs a required pre-connect setting (no form, no connecting)', async () => {
    const tokenServer = await startTokenServer()
    cleanups.push(() => tokenServer.close())
    const calls = stubFetch({
      bootstrap: {
        connectors: [connectorItem(
          tokenServer,
          { auto_auth: 'rbac-assertion', auto_connect: true },
          { settings: [{ key: 'clientId', label: 'Client ID', required: true }] },
        )],
      },
      assertion: () => assertionResponse(tokenServer),
    })
    const { harness } = await makeHarness()

    login(harness)
    await vi.waitFor(() => { expect(calls.some(call => call.url.includes('/bootstrap'))).toBe(true) }, { timeout: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 200))

    const row = await rowOf(harness)
    expect(row?.status).toBe('disconnected')
    expect(row?.request).toBeNull()
    expect(calls.filter(call => call.url.includes('/assertion'))).toHaveLength(0)
    expect(harness.configs).toHaveLength(0)
  })

  it('skips a stdio connector that would require a local approval prompt', async () => {
    const tokenServer = await startTokenServer()
    cleanups.push(() => tokenServer.close())
    const item = connectorItem(tokenServer, { auto_auth: 'rbac-assertion', auto_connect: true })
    item.definition = JSON.stringify({
      ...(JSON.parse(String(item.definition)) as Record<string, unknown>),
      mcp: [{ serverName: 'hr', transport: 'stdio', command: 'node', args: ['--version'] }],
    })
    const calls = stubFetch({
      bootstrap: { connectors: [item] },
      assertion: () => assertionResponse(tokenServer),
    })
    // No `requestApproval` hook: the plugin would otherwise surface the panel
    // confirmation (an interaction) on login.
    const dir = await mkdtemp(join(tmpdir(), 'zk-connectors-auto-stdio-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    const harness = createHarness([], dir, { refreshSweepIntervalMs: 0 })
    cleanups.push(() => { harness.dispose() })

    login(harness)
    await vi.waitFor(() => { expect(calls.some(call => call.url.includes('/bootstrap'))).toBe(true) }, { timeout: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(calls.filter(call => call.url.includes('/assertion'))).toHaveLength(0)
    expect(harness.configs).toHaveLength(0)
    expect(harness.prompts).toHaveLength(0)
    expect((await rowOf(harness))?.status).toBe('disconnected')
  })

  it('re-authorizes a connected silent credential that cannot renew itself and drops a stale client secret', async () => {
    const tokenServer = await startTokenServer()
    cleanups.push(() => tokenServer.close())
    stubFetch({
      bootstrap: { connectors: [connectorItem(tokenServer, { auto_auth: 'rbac-assertion', auto_connect: true })] },
      assertion: () => assertionResponse(tokenServer),
    })
    const { harness, dir } = await makeHarness()
    // A silent credential from an exchange that returned no refresh token, plus
    // a secret left behind by an older dynamic registration.
    await seedCredential(dir, CONNECTOR_ID, {
      accessToken: 'expired-access',
      clientSecret: 'stale-secret',
      clientId: 'zeokeel-connector',
      expiresAt: Date.now() - 3_600_000,
      updatedAt: Date.now(),
    })

    login(harness)
    await vi.waitFor(() => { expect(tokenServer.requests).toHaveLength(1) }, { timeout: 10_000 })
    await vi.waitFor(async () => {
      expect(await readCredential(dir)).toMatchObject({ accessToken: 'access-1' })
    }, { timeout: 10_000 })

    const stored = await readCredential(dir)
    expect(stored).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' })
    expect(stored?.clientSecret).toBeUndefined()
    expect((await rowOf(harness))?.status).toBe('connected')
  })

  it('never reports an auto-mode definition connected without a transport provider', async () => {
    const tokenServer = await startTokenServer()
    cleanups.push(() => tokenServer.close())
    const item: Record<string, unknown> = {
      id: CONNECTOR_ID,
      name: 'HR',
      description: '',
      auth_mode: 'auto',
      definition: JSON.stringify({
        // Only the RBAC token endpoint is declared; no authorize URL, so this
        // definition's OAuth facts are discovery-shaped and cannot back a
        // transport provider. The silent shortcut must not claim it.
        auth: { tokenUrl: tokenServer.tokenUrl, scopes: 'mcp.read' },
        mcp: [{ serverName: 'hr', transport: 'streamable-http', url: MCP_URL }],
      }),
      auto_auth: 'rbac-assertion',
      auto_connect: true,
    }
    const calls = stubFetch({ bootstrap: { connectors: [item] }, assertion: () => assertionResponse(tokenServer) })
    const { harness } = await makeHarness()

    login(harness)
    await vi.waitFor(() => { expect(calls.some(call => call.url.includes('/bootstrap'))).toBe(true) }, { timeout: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(calls.filter(call => call.url.includes('/assertion'))).toHaveLength(0)
    expect(harness.configs).toHaveLength(0)
    const row = await rowOf(harness)
    expect(row?.status).toBe('disconnected')
    expect(harness.warns.join('\n')).not.toContain('静态端点不可用')
  })
})
