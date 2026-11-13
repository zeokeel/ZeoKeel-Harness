/**
 * Silent connector authorization (server-enabled, zero-scan).
 *
 * The ZeoKeel client already knows who is signed in (its session token). The
 * server can sign a short-lived assertion for that identity; the RBAC bridge
 * exchanges it for an MCP token whose `sub` is the same person. This module is
 * the client half of that exchange: get the assertion from the CURRENT session,
 * verify the token endpoint is the one the connector definition already trusts,
 * then exchange and hand the credential patch back to the connector runtime.
 *
 * Every failure returns `null`: silent authorization is an OPTIMIZATION layered
 * over the existing interactive OAuth flow, never a new failure surface. The
 * caller falls back to `runAuth` (or, for auto-connect, leaves the row
 * disconnected without a QR prompt).
 */

import type { ConnectorDef } from './types.ts'
import type { ConnectorCredential } from './store.ts'
import type { HostLocale } from './host-copy.ts'
import { outboundFetch } from './outbound.ts'

const ASSERTION_TIMEOUT_MS = 8_000
const EXCHANGE_TIMEOUT_MS = 8_000

/** The subset of the enterprise session this flow needs. */
export interface SilentAuthSession {
  serverURL?: string | undefined
  token?: string | undefined
  username?: string | undefined
}

export interface SilentAuthOptions {
  session: SilentAuthSession | null
  locale: HostLocale
  signal?: AbortSignal
  /** Login account to stamp on the credential (mismatch guard). */
  username?: string | null
}

/** RFC 8693 token exchange, as implemented by the RBAC bridge. */
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt'

/**
 * Extract one field from a server response without stringifying `undefined`.
 * The assertion/exchange responses are the trust boundary of this feature:
 * anything not a non-empty string is treated as "not available".
 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Same endpoint, modulo trailing slash (definitions and servers disagree). */
function sameEndpoint(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    const normalizePath = (path: string): string => path.replace(/\/+$/, '') || '/'
    return a.origin === b.origin && normalizePath(a.pathname) === normalizePath(b.pathname) && a.search === b.search
  } catch {
    return false
  }
}

function deadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline])
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await response.json()) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Try to obtain this connector's credential from the current login session.
 *
 * @returns a credential patch on success, `null` for every expected failure
 *   (feature off, no session, endpoint mismatch, network error, rejection).
 *   The caller MUST NOT surface `null` as a user-visible error.
 */
export async function trySilentAuth(
  def: ConnectorDef,
  options: SilentAuthOptions,
): Promise<Partial<ConnectorCredential> | null> {
  const session = options.session
  if (session === null || session.serverURL === undefined || session.token === undefined) return null
  const serverURL = session.serverURL.replace(/\/+$/, '')
  if (serverURL === '') return null
  const auth = def.auth as { tokenUrl?: unknown } | undefined
  const expectedTokenUrl = nonEmptyString(auth?.tokenUrl)
  if (expectedTokenUrl === null) return null

  try {
    const assertionURL = `${serverURL}/api/client/v2/connectors/${encodeURIComponent(def.id)}/assertion`
    const assertionRes = await fetch(assertionURL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      signal: deadline(options.signal, ASSERTION_TIMEOUT_MS),
      redirect: 'error',
    })
    if (!assertionRes.ok) return null
    const assertionBody = await readJson(assertionRes)
    if (assertionBody === null) return null
    const assertion = nonEmptyString(assertionBody.assertion)
    const tokenEndpoint = nonEmptyString(assertionBody.token_endpoint)
    const clientId = nonEmptyString(assertionBody.client_id)
    const scope = nonEmptyString(assertionBody.scope)
    const resource = nonEmptyString(assertionBody.resource)
    if (assertion === null || tokenEndpoint === null || clientId === null) return null
    // The definition's own token endpoint is the authority: a compromised or
    // misconfigured server must not be able to redirect the exchange (and the
    // assertion) to a different authorization server.
    if (!sameEndpoint(tokenEndpoint, expectedTokenUrl)) return null

    const form = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: assertion,
      subject_token_type: JWT_TOKEN_TYPE,
      client_id: clientId,
    })
    if (scope !== null) form.set('scope', scope)
    if (resource !== null) form.set('resource', resource)

    const tokenRes = await outboundFetch(tokenEndpoint, 'OAuth token 端点', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, { timeoutMs: EXCHANGE_TIMEOUT_MS, locale: options.locale })
    if (!tokenRes.ok) return null
    const tokenBody = await readJson(tokenRes)
    if (tokenBody === null) return null
    const accessToken = nonEmptyString(tokenBody.access_token)
    if (accessToken === null) return null

    const expiresAt = typeof tokenBody.expires_in === 'number'
      ? Date.now() + tokenBody.expires_in * 1000
      : undefined
    const refreshToken = nonEmptyString(tokenBody.refresh_token)
    const account = options.username ?? session.username ?? null
    return {
      accessToken,
      clientId,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(refreshToken === null ? {} : { refreshToken }),
      ...(account === null || account === '' ? {} : { account }),
    }
  } catch {
    // Every failure is the same outcome: fall back to the interactive flow.
    // No assertion/token is ever logged here.
    return null
  }
}
