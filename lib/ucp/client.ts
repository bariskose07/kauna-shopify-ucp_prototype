// UCP transport: discovery, auth, JSON-RPC 2.0 over HTTPS, error separation.
//
// Auth follows Shopify's "Authenticate your agent" flow (README "Kimlik
// doğrulama"):
//   • SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET → client_credentials JWT from
//     https://api.shopify.com/auth/access_token (60 min; refreshed 1 min early).
//   • Per call:  Global Catalog      → Authorization: Bearer <token>
//                merchant catalog    → no token (by design)
//                cart tools          → no token (by design)
//                checkout tools      → Authorization: Bearer <token>
//   • No silent fallback: a missing or rejected token is an error unless the
//     test-only setting "token'sız dene" is on, and then every such call is
//     labelled "token yok – yedek".
//   • CLI adapter (cli-adapter.ts) only when the test setting selects it.
//
// Server-only module: never import from a client component.

import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

import { maskPII } from '../mask'
import { UcpError, parseRetryAfter } from './errors'
import { pathStatus, validate, type ValidationReport } from './schema'
import type { Json, UcpMeta } from './types'

// ─── safety rail (rule 1) ────────────────────────────────────────────────────
// No code path in this prototype may place an order. The tool name is refused
// here, at the single choke point every UCP call goes through.
const FORBIDDEN_TOOLS: ReadonlySet<string> = new Set(['complete_checkout'])

export const SUPPORTED_VERSIONS = ['2026-08-25', '2026-04-08'] as const
/** MCP transport revision sent on every JSON-RPC request. */
export const MCP_PROTOCOL_VERSION = '2026-03-26'
/** Shopify's example agent profiles (Authenticate your agent, steps 3–5). */
export const CATALOG_PROFILE = 'https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json'
/**
 * Profile for cart + checkout calls. The business negotiates extensions from
 * the capabilities this profile declares. Observed live (AAB, 2026-10-02):
 * with `examples/2026-08-25/cart-and-checkout.json` the update_checkout schema
 * had NO `fulfillment` and NO `discounts`, so no shipping address or
 * discount code could be sent. This one (what @shopify/ucp-cli presents)
 * declares cart, checkout, fulfillment, discount, buyer_consent and order.
 */
export const CART_CHECKOUT_PROFILE = 'https://shopify.dev/ucp/agent-profiles/2026-08-25/valid-with-capabilities.json'
/** Capabilities the cart/checkout profile must declare for the flow to work. */
export const REQUIRED_MERCHANT_CAPABILITIES = ['dev.ucp.shopping.cart', 'dev.ucp.shopping.checkout', 'dev.ucp.shopping.fulfillment'] as const
const TOKEN_URL_DEFAULT = 'https://api.shopify.com/auth/access_token'
/** Checkout tools carry the Bearer token; cart tools never do. */
export const CHECKOUT_TOOLS: ReadonlySet<string> = new Set(['create_checkout', 'get_checkout', 'update_checkout', 'cancel_checkout'])

const USER_AGENT = 'kauna-ucp-prototype/0.1 (+https://kauna.ai)'
const TIMEOUT_MS = 30_000
const DISCOVERY_TTL_MS = 5 * 60_000
const TOOLS_TTL_MS = 60_000 // UCP minimum cache for tools/list

function catalogEndpoint(): string | undefined {
  const raw = process.env.SHOPIFY_CATALOG_URL
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    return u.pathname && u.pathname !== '/' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

// ─── runtime test settings (Ayarlar → "Kimlik (yalnızca test)") ────────────
// Both default OFF. Seeded from env so scripts can flip them, changeable at
// runtime from the settings page. Kept in memory only.
export interface AuthSettings {
  /** Token missing/rejected → retry the same call without it (test only). */
  tokenlessFallback: boolean
  /** Route every call through @shopify/ucp-cli (test only). */
  cliTransport: boolean
}
const settings: AuthSettings = ((globalThis as unknown as { __ucpAuthSettings?: AuthSettings }).__ucpAuthSettings ??= {
  tokenlessFallback: process.env.UCP_TOKENLESS_FALLBACK === '1',
  cliTransport: process.env.UCP_TRANSPORT === 'cli',
})
export function getAuthSettings(): AuthSettings {
  return { ...settings }
}
export function setAuthSettings(patch: Partial<AuthSettings>): AuthSettings {
  if (typeof patch.tokenlessFallback === 'boolean') settings.tokenlessFallback = patch.tokenlessFallback
  if (typeof patch.cliTransport === 'boolean') settings.cliTransport = patch.cliTransport
  console.info(`[ucp] test ayarları: token'sız yedek=${settings.tokenlessFallback ? 'AÇIK' : 'kapalı'} cli=${settings.cliTransport ? 'AÇIK' : 'kapalı'}`)
  return getAuthSettings()
}

// ─── credentials ─────────────────────────────────────────────────────────────
// One source of truth: SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET. Older names
// are still read so an existing .env keeps working, with a warning.
const LEGACY_CREDENTIALS: [string, string][] = [
  ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET'],
  ['UCP_CLIENT_ID', 'UCP_CLIENT_SECRET'],
  ['CLIENT_ID', 'CLIENT_SECRET'],
]
let legacyWarned = false
export function credentials(): { id?: string; secret?: string; source?: string; warning?: string } {
  const id = process.env.SHOPIFY_CLIENT_ID
  const secret = process.env.SHOPIFY_CLIENT_SECRET
  if (id && secret) return { id, secret, source: 'SHOPIFY_CLIENT_ID/SECRET' }
  for (const [ki, ks] of LEGACY_CREDENTIALS) {
    if (process.env[ki] && process.env[ks]) {
      const warning = `Eski değişken adları kullanılıyor (${ki}/${ks}). .env içinde SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET olarak yeniden adlandırın.`
      if (!legacyWarned) {
        legacyWarned = true
        console.warn(`[ucp] ${warning}`)
      }
      return { id: process.env[ki], secret: process.env[ks], source: `${ki}/${ks}`, warning }
    }
  }
  return {}
}

export function config() {
  const creds = credentials()
  return {
    transport: settings.cliTransport ? ('cli' as const) : ('direct' as const),
    hasClientCredentials: Boolean(creds.id && creds.secret),
    /** Optional own profile for cart + checkout (used only if it declares both). */
    profileOverride: process.env.UCP_AGENT_PROFILE_URL || undefined,
    // SHOPIFY_CATALOG_URL (Dev Dashboard) is the MCP endpoint itself, e.g.
    // https://catalog.shopify.com/api/ucp/mcp; its origin is the catalog business.
    catalogUrl: catalogEndpoint() ? new URL(catalogEndpoint() as string).origin : process.env.UCP_CATALOG_URL || 'https://catalog.shopify.com',
    catalogEndpoint: catalogEndpoint(),
    /** Dev Dashboard catalog id — sent as `catalog.catalog_id` (see catalog.ts). */
    catalogId: process.env.SHOPIFY_CATALOG_ID || undefined,
    defaultSeller: process.env.DEFAULT_SELLER || 'https://us.aabcollection.com',
    maxRetryAfter: Number(process.env.UCP_MAX_RETRY_AFTER_SECONDS ?? 5),
    /** Overridable only so the offline mock can stand in for api.shopify.com. */
    tokenUrl: process.env.SHOPIFY_AUTH_URL || TOKEN_URL_DEFAULT,
  }
}

// ─── auth: client-credentials token ─────────────────────────────────────────

/** Claims we read from the token (payload only; the signature is Shopify's business). */
export interface TokenClaims {
  scopes: string[]
  /** epoch seconds */
  exp?: number
  limits?: unknown
}

interface CachedToken {
  token: string
  expiresAt: number
  obtainedAt: number
  claims: TokenClaims
}

const g = globalThis as unknown as {
  __ucpToken?: CachedToken
  __ucpDisc?: Map<string, { at: number; value: Discovered }>
  __ucpTools?: Map<string, { at: number; value: Record<string, ToolDescriptor> }>
}
const discCache = (g.__ucpDisc ??= new Map())
const toolsCache = (g.__ucpTools ??= new Map())

const REFRESH_EARLY_MS = 60_000
const TOKEN_RETRY_MS = 60_000

/** Decode a JWT payload (no verification — display and expiry only). */
export function decodeJwt(token: string): TokenClaims {
  try {
    const part = token.split('.')[1]
    if (!part) return { scopes: [] }
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Json
    const raw = json.scopes ?? json.scope ?? json.scp
    const scopes = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[\s,]+/).filter(Boolean) : []
    return { scopes, exp: typeof json.exp === 'number' ? json.exp : undefined, limits: json.limits }
  } catch {
    return { scopes: [] }
  }
}

let tokenInFlight: Promise<string | undefined> | undefined

/**
 * The single token getter. Returns undefined only when no credentials are
 * configured; any exchange failure throws (and is remembered for the banner).
 */
export async function getAccessToken(): Promise<string | undefined> {
  const { id, secret } = credentials()
  if (!id || !secret) return undefined
  const cached = g.__ucpToken
  if (cached && cached.expiresAt - REFRESH_EARLY_MS > Date.now()) return cached.token
  // Don't hammer the token endpoint after a failure: at most once a minute.
  if (tokenState.error && Date.now() - tokenState.error.at < TOKEN_RETRY_MS) {
    throw new UcpError({ kind: 'auth', httpStatus: tokenState.error.httpStatus, message: tokenState.error.message })
  }
  // Parallel calls share one token request.
  tokenInFlight ??= fetchToken(id, secret)
    .then((t) => {
      tokenState.error = undefined
      return t
    })
    .catch((e: UcpError) => {
      tokenState.error = { at: Date.now(), message: e.message, httpStatus: e.httpStatus }
      console.warn(`[ucp] token alınamadı: ${e.message}`)
      throw e
    })
    .finally(() => {
      tokenInFlight = undefined
    })
  return tokenInFlight
}

async function fetchToken(id: string, secret: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(config().tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    // Network failure, not bad credentials.
    throw new UcpError({ kind: 'auth', message: `token uç noktasına ulaşılamadı (${new URL(config().tokenUrl).host}): ${(e as Error).message}` })
  }
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    scope?: string
    error?: string
    error_description?: string
    message?: string
  }
  if (!res.ok || !body.access_token) {
    // Only the standard OAuth error fields are surfaced — never the request
    // or anything credential-like.
    const why = [body.error, body.error_description ?? body.message].filter(Boolean).join(': ')
    throw new UcpError({
      kind: 'auth',
      httpStatus: res.status,
      message: `HTTP ${res.status}${why ? ` — ${why.slice(0, 200)}` : ''}`,
    })
  }
  const claims = decodeJwt(body.access_token)
  if (claims.scopes.length === 0 && body.scope) claims.scopes = body.scope.split(/[\s,]+/).filter(Boolean)
  const now = Date.now()
  g.__ucpToken = {
    token: body.access_token,
    obtainedAt: now,
    expiresAt: claims.exp ? claims.exp * 1000 : now + (body.expires_in ?? 3600) * 1000,
    claims,
  }
  console.info(
    `[ucp] token alındı: scopes=[${claims.scopes.join(' ')}] exp=${new Date(g.__ucpToken.expiresAt).toISOString()} token=${maskToken(body.access_token)}`,
  )
  return body.access_token
}

/** Only ever show a token as its first 6 characters. */
export function maskToken(t: string | undefined): string {
  return t ? `${t.slice(0, 6)}…(${t.length})` : '—'
}

// ─── discovery ───────────────────────────────────────────────────────────────

export interface Discovered {
  business: string
  version: string
  source: 'well-known' | 'supported_versions' | 'fallback'
  businessProfileUrl: string
  endpoint: string
  /** Profile sent with tools/list on this endpoint (per-call profile: profileFor()). */
  agentProfileUrl: string
  /** Why discovery fell back to {origin}/api/ucp/mcp, if it did. */
  note?: string
  capabilities: unknown
  paymentHandlers: unknown
  /** Full business profile (not catalog data — safe to keep briefly). */
  profile: Json
}

export interface ToolDescriptor {
  name: string
  description?: string
  inputSchema: unknown
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown; finalUrl: string }> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new UcpError({ kind: 'network', message: `${url} erişilemedi: ${(e as Error).message}` })
  }
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 500) }
  }
  return { status: res.status, body, finalUrl: res.url }
}

type ServiceEntry = { version?: string; transport?: string; endpoint?: string; [k: string]: unknown }

/** Normalise the shopping service declaration across spec renderings. */
function shoppingEntries(profile: Json): ServiceEntry[] {
  const ucp = (profile.ucp ?? {}) as Json
  const services = (ucp.services ?? {}) as Json
  const raw = services['dev.ucp.shopping']
  if (Array.isArray(raw)) return raw as ServiceEntry[]
  // Older rendering: { version, mcp: { endpoint }, rest: { endpoint } }
  if (raw && typeof raw === 'object') {
    const r = raw as Json
    const out: ServiceEntry[] = []
    for (const t of ['mcp', 'rest', 'embedded'])
      if (r[t] && typeof r[t] === 'object')
        out.push({ version: r.version as string, transport: t, ...(r[t] as Json) })
    return out
  }
  return []
}

export async function discover(businessUrl: string, force = false): Promise<Discovered> {
  const origin = new URL(businessUrl).origin
  const hit = discCache.get(origin)
  if (!force && hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.value

  // Explicit catalog endpoint from the Dev Dashboard wins over discovery.
  // /.well-known/ucp is still read (for the version) when reachable.
  const { catalogEndpoint: explicit } = config()
  if (explicit && new URL(explicit).origin === origin) {
    let base: Discovered | undefined
    try {
      base = await discoverWellKnown(origin)
    } catch {
      base = undefined
    }
    const version = base?.version ?? process.env.UCP_CATALOG_VERSION ?? '2026-04-08'
    const value: Discovered = {
      business: origin,
      version,
      source: base?.source ?? 'well-known',
      businessProfileUrl: base?.businessProfileUrl ?? '(SHOPIFY_CATALOG_URL — keşif atlandı)',
      endpoint: explicit,
      agentProfileUrl: CATALOG_PROFILE,
      capabilities: base?.capabilities,
      paymentHandlers: base?.paymentHandlers,
      profile: base?.profile ?? {},
    }
    discCache.set(origin, { at: Date.now(), value })
    return value
  }
  let value: Discovered
  try {
    value = await discoverWellKnown(origin)
  } catch (e) {
    // /.well-known/ucp unreachable or without an MCP entry → Shopify's
    // standard path. A version mismatch is a real incompatibility: no fallback.
    if (!(e instanceof UcpError) || (e.kind !== 'discovery' && e.kind !== 'network') || /Ortak UCP sürümü yok/.test(e.message)) throw e
    const endpoint = `${origin}/api/ucp/mcp`
    console.warn(`[ucp] keşif başarısız (${e.message.slice(0, 120)}) → ${endpoint}`)
    value = {
      business: origin,
      version: process.env.UCP_CATALOG_VERSION ?? SUPPORTED_VERSIONS[0],
      source: 'fallback',
      businessProfileUrl: `${origin}/.well-known/ucp (okunamadı)`,
      endpoint,
      agentProfileUrl: await merchantToolsProfile(),
      capabilities: undefined,
      paymentHandlers: undefined,
      profile: {},
      note: `/.well-known/ucp okunamadı → ${endpoint} kullanıldı: ${e.message.slice(0, 200)}`,
    }
  }
  discCache.set(origin, { at: Date.now(), value })
  return value
}

async function discoverWellKnown(origin: string): Promise<Discovered> {

  const wellKnown = `${origin}/.well-known/ucp`
  const top = await getJson(wellKnown)
  if (top.status !== 200 || typeof top.body !== 'object' || top.body === null || !('ucp' in top.body)) {
    throw new UcpError({
      kind: 'discovery',
      httpStatus: top.status,
      message: `${wellKnown} UCP profili döndürmedi (HTTP ${top.status}). Mağaza UCP desteklemiyor olabilir.`,
    })
  }
  let profile = top.body as Json
  let profileUrl = top.finalUrl || wellKnown
  let source: Discovered['source'] = 'well-known'
  const topUcp = profile.ucp as Json
  const topVersion = String(topUcp.version ?? '')
  const supported = (topUcp.supported_versions ?? {}) as Record<string, string>

  // Pick the newest release both sides speak (same rule as ucp-cli).
  const offered = new Set([topVersion, ...Object.keys(supported)])
  const version = SUPPORTED_VERSIONS.find((v) => offered.has(v))
  if (!version) {
    throw new UcpError({
      kind: 'discovery',
      message: `Ortak UCP sürümü yok. Mağaza: [${[...offered].join(', ')}], prototip: [${SUPPORTED_VERSIONS.join(', ')}]`,
    })
  }
  if (version !== topVersion && supported[version]) {
    const leaf = await getJson(supported[version])
    if (leaf.status !== 200) {
      throw new UcpError({ kind: 'discovery', message: `supported_versions[${version}] alınamadı (HTTP ${leaf.status})` })
    }
    profile = leaf.body as Json
    profileUrl = supported[version]
    source = 'supported_versions'
  }

  const entries = shoppingEntries(profile)
  const entry =
    entries.find((e) => e.transport === 'mcp' && e.version === version) ?? entries.find((e) => e.transport === 'mcp')
  if (!entry?.endpoint) {
    throw new UcpError({
      kind: 'discovery',
      message: `dev.ucp.shopping için MCP uç noktası ilan edilmemiş (${profileUrl})`,
      details: entries,
    })
  }
  const ucp = profile.ucp as Json
  const value: Discovered = {
    business: origin,
    version,
    source,
    businessProfileUrl: profileUrl,
    endpoint: entry.endpoint,
    // tools/list on a merchant endpoint uses the cart+checkout profile (the
    // tools Kauna needs there); the catalog endpoint uses the catalog profile.
    agentProfileUrl: isCatalogEndpoint(entry.endpoint) ? CATALOG_PROFILE : await merchantToolsProfile(),
    capabilities: ucp.capabilities,
    paymentHandlers: ucp.payment_handlers,
    profile,
  }
  return value
}

// ─── JSON-RPC ────────────────────────────────────────────────────────────────

let rpcId = 1

// ─── buyer context (Shopify-Buyer-IP) ────────────────────────────────────────
// Shopify's Checkout MCP requires `Shopify-Buyer-IP` (the buyer's IPv4/IPv6)
// on token-authenticated checkout calls; without it: HTTP 422 / -32000
// "AuthenticationFailed" with data "Missing required buyer IP header." (seen
// live 2026-10-02). Header name from Shopify's own demo
// (shopify-apac-ts/shopify-ucp-demo-mcp, src/checkout.ts). The buyer's
// User-Agent is forwarded the same way.
//
// Source of the IP: the incoming request (X-Forwarded-For / X-Real-IP, only
// trustworthy behind your own proxy) when it is a public address; otherwise
// UCP_BUYER_IP (local testing: localhost / Wi-Fi addresses are private).

export interface BuyerContext {
  ip?: string
  ipSource?: 'istek' | 'UCP_BUYER_IP'
  userAgent?: string
}

/** Private, loopback, link-local and unique-local addresses are not a buyer's IP. */
export function isPublicIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number)
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127))
  }
  if (v === 6) {
    const l = ip.toLowerCase()
    if (l.startsWith('::ffff:')) return isPublicIp(l.slice(7))
    return !(l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb'))
  }
  return false
}

export async function buyerContext(): Promise<BuyerContext> {
  let reqIp: string | undefined
  let userAgent: string | undefined
  try {
    // Only inside a Next.js request; anywhere else (tests, scripts) this throws.
    const { headers } = await import('next/headers')
    const h = await headers()
    reqIp = (h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? '').trim() || undefined
    userAgent = h.get('user-agent') ?? undefined
  } catch {
    /* no request scope */
  }
  if (reqIp && isPublicIp(reqIp)) return { ip: reqIp, ipSource: 'istek', userAgent }
  const env = process.env.UCP_BUYER_IP?.trim()
  if (env && isIP(env)) return { ip: env, ipSource: 'UCP_BUYER_IP', userAgent }
  return { userAgent }
}

/** For logs/UI: keep only the network part (IPv4 a.b.x.x, IPv6 first 2 groups). */
export function maskIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined
  if (isIP(ip) === 4) return ip.split('.').slice(0, 2).join('.') + '.x.x'
  return ip.split(':').slice(0, 2).join(':') + ':…'
}

const BUYER_IP_MISSING = /buyer IP header/i
export function isBuyerIpError(e: unknown): boolean {
  return e instanceof UcpError && BUYER_IP_MISSING.test(`${e.message} ${JSON.stringify(e.data ?? '')}`)
}

// ─── per-call auth policy ───────────────────────────────────────────────────

export type Surface = 'global-catalog' | 'merchant-catalog' | 'cart' | 'checkout'

export function isCatalogEndpoint(endpoint: string): boolean {
  return new URL(endpoint).origin === new URL(config().catalogUrl).origin
}

export function surfaceOf(endpoint: string, tool: string): Surface {
  if (isCatalogEndpoint(endpoint)) return 'global-catalog'
  if (CHECKOUT_TOOLS.has(tool) || tool.includes('checkout')) return 'checkout'
  if (tool.includes('cart')) return 'cart'
  return 'merchant-catalog'
}

/** Shopify's rule: Bearer on Global Catalog and checkout tools, nothing else. */
export function tokenRequired(surface: Surface, tool: string): boolean {
  if (surface === 'global-catalog') return true
  return surface === 'checkout' && CHECKOUT_TOOLS.has(tool)
}

/**
 * How a request identified itself:
 *   token    — Authorization: Bearer <client_credentials JWT>
 *   none     — no token, because the surface does not take one ("tasarım gereği")
 *   fallback — no token although the surface needs one; only with the test
 *              setting "token'sız dene" ("token yok – yedek")
 *   cli      — delegated to @shopify/ucp-cli (test setting)
 */
export type AuthMode = 'token' | 'none' | 'fallback' | 'cli'
export const AUTH_LABEL: Record<AuthMode, string> = {
  token: 'token',
  none: 'token yok – tasarım gereği',
  fallback: 'token yok – yedek',
  cli: 'CLI (test)',
}
export interface AuthInfo {
  mode: AuthMode
  label: string
  /** Why this mode (e.g. "token reddedildi → token'sız yedek"). */
  note?: string
  /** Agent profile sent in meta["ucp-agent"].profile. */
  profile?: string
  /** Token facts at send time (never the token itself). */
  tokenScopes?: string[]
  tokenExpiresAt?: number
  /** Shopify-Buyer-IP sent (masked) and where it came from. */
  buyerIp?: string
  buyerIpSource?: string
}

function authInfo(mode: AuthMode, extra: Partial<AuthInfo> = {}): AuthInfo {
  return { mode, label: AUTH_LABEL[mode], ...extra }
}

export interface TokenState {
  configured: boolean
  status: 'not-configured' | 'not-requested' | 'ok' | 'failed'
  credentialSource?: string
  warning?: string
  expiresAt?: number
  obtainedAt?: number
  scopes?: string[]
  limits?: unknown
  error?: { at: number; message: string; httpStatus?: number }
  /** Last time a business rejected the token (AuthenticationFailed). */
  rejected?: { at: number; host: string; tool: string; message: string }
}
const tokenState: { error?: TokenState['error']; rejected?: TokenState['rejected'] } = ((
  globalThis as unknown as { __ucpTokenState?: { error?: TokenState['error']; rejected?: TokenState['rejected'] } }
).__ucpTokenState ??= {})

export function getTokenState(): TokenState {
  const creds = credentials()
  const configured = Boolean(creds.id && creds.secret)
  const base = { configured, credentialSource: creds.source, warning: creds.warning, rejected: tokenState.rejected }
  if (!configured) return { ...base, status: 'not-configured' }
  const t = g.__ucpToken
  if (tokenState.error) return { ...base, status: 'failed', error: tokenState.error }
  if (t && t.expiresAt > Date.now())
    return { ...base, status: 'ok', expiresAt: t.expiresAt, obtainedAt: t.obtainedAt, scopes: t.claims.scopes, limits: t.claims.limits }
  return { ...base, status: 'not-requested' }
}

// ─── agent profiles ─────────────────────────────────────────────────────────

const overrideCheck: { url?: string; ok?: boolean; reason?: string } = ((globalThis as unknown as {
  __ucpProfileCheck?: { url?: string; ok?: boolean; reason?: string }
}).__ucpProfileCheck ??= {})

/** Does a profile JSON declare cart, checkout and fulfillment (address)? */
export function declaresCartAndCheckout(profile: unknown): boolean {
  const caps = ((profile as Json | undefined)?.ucp as Json | undefined)?.capabilities
  const names = Array.isArray(caps)
    ? caps.map((c) => String((c as Json)?.name ?? ''))
    : caps && typeof caps === 'object'
      ? Object.keys(caps)
      : []
  return REQUIRED_MERCHANT_CAPABILITIES.every((c) => names.includes(c))
}

/**
 * Profile for cart + checkout calls: UCP_AGENT_PROFILE_URL when it declares
 * both capabilities, otherwise Shopify's cart-and-checkout example.
 */
async function merchantToolsProfile(): Promise<string> {
  const url = config().profileOverride
  if (!url) return CART_CHECKOUT_PROFILE
  if (overrideCheck.url !== url) {
    overrideCheck.url = url
    try {
      const r = await getJson(url)
      overrideCheck.ok = r.status === 200 && declaresCartAndCheckout(r.body)
      overrideCheck.reason = overrideCheck.ok ? undefined : r.status !== 200 ? `HTTP ${r.status}` : 'cart + checkout + fulfillment yeteneklerini ilan etmiyor'
    } catch (e) {
      overrideCheck.ok = false
      overrideCheck.reason = (e as Error).message
    }
    if (!overrideCheck.ok) console.warn(`[ucp] UCP_AGENT_PROFILE_URL kullanılmadı (${overrideCheck.reason}) → ${CART_CHECKOUT_PROFILE}`)
  }
  return overrideCheck.ok ? url : CART_CHECKOUT_PROFILE
}

export function profileStatus() {
  return {
    catalog: CATALOG_PROFILE,
    cartCheckout: overrideCheck.ok && overrideCheck.url ? overrideCheck.url : CART_CHECKOUT_PROFILE,
    override: config().profileOverride ? { url: config().profileOverride, used: Boolean(overrideCheck.ok), reason: overrideCheck.reason } : null,
  }
}

export async function profileFor(surface: Surface): Promise<string> {
  return surface === 'cart' || surface === 'checkout' ? merchantToolsProfile() : CATALOG_PROFILE
}

// ─── per-surface status (for the top-bar indicator) ─────────────────────────

export interface SurfaceStatus {
  surface: Surface
  auth: AuthInfo
  at: number
  host: string
  endpoint: string
  tool: string
  ok: boolean
  error?: string
  /** The business rejected our token (AuthenticationFailed). */
  authRejected?: boolean
  retryAfterSeconds?: number
}
const surfaceStatus: Map<Surface, SurfaceStatus> = ((globalThis as unknown as { __ucpSurface?: Map<Surface, SurfaceStatus> }).__ucpSurface ??= new Map())

export function getSurfaceStatus(): SurfaceStatus[] {
  return [...surfaceStatus.values()]
}

export function recordSurface(endpoint: string, tool: string, auth: AuthInfo, ok: boolean, err?: UcpError, ms?: number) {
  const surface = surfaceOf(endpoint, tool)
  const host = new URL(endpoint).host
  surfaceStatus.set(surface, {
    surface,
    auth,
    at: Date.now(),
    host,
    endpoint,
    tool,
    ok,
    error: err ? `${err.kind}: ${err.message}`.slice(0, 240) : undefined,
    authRejected: err ? isAuthRejection(err) : undefined,
    retryAfterSeconds: err?.retryAfterSeconds,
  })
  // Server log line — one per UCP request (no payloads, no PII, no token).
  const tok =
    auth.mode === 'token'
      ? ` scopes=[${(auth.tokenScopes ?? []).join(' ')}]${auth.tokenExpiresAt ? ` exp=${new Date(auth.tokenExpiresAt).toISOString()}` : ''}`
      : ''
  const line = `[ucp] ${tool} → ${host} surface=${surface} auth="${auth.label}"${auth.note ? ` (${auth.note})` : ''}${tok} profile=${auth.profile ?? '—'} ${ok ? 'ok' : `ERR ${err?.kind}${err?.rpcCode !== undefined ? ` ${err.rpcCode}` : ''}${err?.httpStatus ? ` http=${err.httpStatus}` : ''}`}${ms !== undefined ? ` ${ms}ms` : ''}`
  if (ok) console.info(line)
  else console.warn(line)
}

/** Filled in by rpc() so callers can attribute the request. */
export interface RpcInfo {
  auth?: AuthInfo
  /** Profile to report (rpc does not read params). */
  profile?: string
  /** Buyer IP / User-Agent forwarded on checkout calls. */
  buyer?: BuyerContext
}

/** A business saying "your token is not accepted here". */
export function isAuthRejection(e: unknown): boolean {
  if (!(e instanceof UcpError)) return false
  // Same -32000 "AuthenticationFailed" envelope, but the token was fine.
  if (isBuyerIpError(e)) return false
  if (e.kind === 'auth' && (e.details as { rejected?: boolean } | undefined)?.rejected) return true
  if (e.httpStatus === 401 || e.httpStatus === 403) return true
  const text = `${e.message} ${JSON.stringify(e.data ?? '')}`
  return /AuthenticationFailed|Unauthori[sz]ed|invalid[_ ]token|token (?:is )?(?:invalid|expired)/i.test(text)
}

// Endpoint → epoch ms until which the business asked us to back off (429).
// While blocked we do not call it at all: hammering a rate-limited endpoint
// can only prolong the block. Observed live: Retry-After ≈ 3600 s.
const blockedUntil: Map<string, number> = ((globalThis as unknown as { __ucpBlocked?: Map<string, number> }).__ucpBlocked ??=
  new Map())

export function rateLimitRemaining(endpoint: string): number | undefined {
  const until = blockedUntil.get(endpoint)
  if (until === undefined) return undefined
  const left = Math.ceil((until - Date.now()) / 1000)
  if (left <= 0) {
    blockedUntil.delete(endpoint)
    return undefined
  }
  return left
}

/**
 * One JSON-RPC call. Protocol failures throw UcpError; a successful `result`
 * is returned untouched (business messages inside it are NOT errors).
 * The Authorization header is decided here, from the surface (see
 * tokenRequired). HTTP 429 → wait `Retry-After` once when it is short,
 * otherwise remember the block (circuit breaker above) and surface it.
 */
export async function rpc<T = unknown>(
  endpoint: string,
  method: string,
  params: unknown,
  attempt = 0,
  info: RpcInfo = {},
): Promise<T> {
  const left = rateLimitRemaining(endpoint)
  if (left !== undefined) {
    throw new UcpError({
      kind: 'rate_limited',
      httpStatus: 429,
      retryAfterSeconds: left,
      message: `Hız limiti sürüyor (${Math.ceil(left / 60)} dk kaldı). Süre bitene kadar bu uç noktaya istek gönderilmiyor.`,
    })
  }
  const tool = method === 'tools/call' ? String((params as Json | undefined)?.name ?? method) : method
  const surface = surfaceOf(endpoint, tool)
  const profile = info.profile
  const host = new URL(endpoint).host

  let headers: Record<string, string> = {}
  if (!tokenRequired(surface, tool)) {
    info.auth = authInfo('none', { profile })
  } else {
    try {
      const token = await getAccessToken()
      if (!token) throw new UcpError({ kind: 'auth', message: 'SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET tanımlı değil' })
      const t = g.__ucpToken
      headers = { Authorization: `Bearer ${token}` }
      info.auth = authInfo('token', { profile, tokenScopes: t?.claims.scopes, tokenExpiresAt: t?.expiresAt })
    } catch (e) {
      const err = e as UcpError
      if (!settings.tokenlessFallback) {
        info.auth = authInfo('token', { profile, note: 'token alınamadı — istek gönderilmedi' })
        throw new UcpError({
          kind: 'auth',
          httpStatus: err.httpStatus,
          message: `Token alınamadı: ${err.message}. ${tool} → ${host} gönderilmedi (token'sız deneme kapalı).`,
        })
      }
      info.auth = authInfo('fallback', { profile, note: `token alınamadı: ${err.message}` })
    }
  }

  // Checkout calls carry the buyer's IP (and User-Agent) — see buyerContext().
  if (surface === 'checkout' && CHECKOUT_TOOLS.has(tool)) {
    const b = info.buyer ?? (await buyerContext())
    if (b.ip) headers['Shopify-Buyer-IP'] = b.ip
    if (b.userAgent) headers['User-Agent'] = b.userAgent
    if (info.auth) {
      info.auth.buyerIp = b.ip ? maskIp(b.ip) : undefined
      info.auth.buyerIpSource = b.ip ? b.ipSource : 'yok — .env içinde UCP_BUYER_IP tanımlayın'
    }
  }

  try {
    return await send<T>(endpoint, method, params, headers, attempt)
  } catch (e) {
    if (isBuyerIpError(e)) {
      const err = e as UcpError
      throw new UcpError({
        kind: 'jsonrpc',
        rpcCode: err.rpcCode,
        httpStatus: err.httpStatus,
        data: err.data,
        message: `Alıcı IP başlığı eksik/geçersiz (Shopify-Buyer-IP) — ${host} token'ı kabul etti ama alıcının genel IP adresini istiyor (${tool}). ${headers['Shopify-Buyer-IP'] ? 'Gönderilen IP reddedildi.' : "Yerel testte .env'ye UCP_BUYER_IP=<genel IP> ekleyin."} Mağaza yanıtı: ${err.message}`,
      })
    }
    if (info.auth?.mode !== 'token' || !isAuthRejection(e)) throw e
    const err = e as UcpError
    tokenState.rejected = { at: Date.now(), host, tool, message: err.message.slice(0, 240) }
    console.warn(`[ucp] AuthenticationFailed: ${host} token'ı reddetti (${tool}): ${err.message.slice(0, 160)}`)
    if (settings.tokenlessFallback) {
      // Test-only: same call once more without the token, clearly labelled.
      info.auth = authInfo('fallback', { profile, note: `token reddedildi (${err.rpcCode ?? err.httpStatus ?? 'auth'}) → token'sız yedek` })
      const { Authorization: _drop, ...rest } = headers
      return send<T>(endpoint, method, params, rest, attempt)
    }
    throw new UcpError({
      kind: 'auth',
      rpcCode: err.rpcCode,
      httpStatus: err.httpStatus,
      data: err.data,
      details: { rejected: true },
      message: `AuthenticationFailed — ${host} token'ı reddetti (${tool}). Token'sız deneme kapalı. Mağaza yanıtı: ${err.message}`,
    })
  }
}

async function send<T>(endpoint: string, method: string, params: unknown, auth: Record<string, string>, attempt: number): Promise<T> {
  const id = rpcId++
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        'User-Agent': USER_AGENT,
        ...auth,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    if (e instanceof UcpError) throw e
    throw new UcpError({ kind: 'network', message: `${endpoint} (${method}) erişilemedi: ${(e as Error).message}` })
  }

  if (res.status === 429) {
    const wait = parseRetryAfter(res.headers.get('retry-after'))
    const max = config().maxRetryAfter
    if (attempt === 0 && wait !== undefined && wait <= max) {
      await new Promise((r) => setTimeout(r, wait * 1000))
      return send<T>(endpoint, method, params, auth, attempt + 1)
    }
    if (wait !== undefined) blockedUntil.set(endpoint, Date.now() + wait * 1000)
    throw new UcpError({
      kind: 'rate_limited',
      httpStatus: 429,
      retryAfterSeconds: wait,
      message: `Hız limiti (HTTP 429). ${wait !== undefined ? `${wait} sn sonra tekrar deneyin.` : 'Retry-After başlığı yok.'}`,
    })
  }

  const text = await res.text()
  let body: { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }
  try {
    body = JSON.parse(text)
  } catch {
    throw new UcpError({
      kind: 'http',
      httpStatus: res.status,
      message: `JSON olmayan yanıt (HTTP ${res.status}) — ${text.slice(0, 200)}`,
    })
  }
  if (body.error) {
    // UCP: MCP servers SHOULD put the back-off in error.data.retry_after.
    const data = (body.error.data ?? {}) as { retry_after?: unknown }
    const ra = typeof data.retry_after === 'number' ? data.retry_after : typeof data.retry_after === 'string' ? parseRetryAfter(data.retry_after) : undefined
    if (ra !== undefined) {
      blockedUntil.set(endpoint, Date.now() + ra * 1000)
      throw new UcpError({
        kind: 'rate_limited',
        rpcCode: body.error.code,
        retryAfterSeconds: ra,
        message: `Hız limiti (JSON-RPC ${body.error.code}: ${body.error.message}). ${ra} sn sonra tekrar deneyin.`,
        data: body.error.data,
      })
    }
    throw new UcpError({
      kind: 'jsonrpc',
      rpcCode: body.error.code,
      httpStatus: res.ok ? undefined : res.status,
      message: `JSON-RPC ${body.error.code}: ${body.error.message}`,
      data: body.error.data,
    })
  }
  if (!res.ok) {
    throw new UcpError({ kind: 'http', httpStatus: res.status, message: `HTTP ${res.status}`, data: body })
  }
  if (body.id !== id) {
    throw new UcpError({ kind: 'http', message: `JSON-RPC id uyuşmazlığı (${String(body.id)} ≠ ${id})` })
  }
  return body.result as T
}

export async function listTools(disc: Discovered, force = false): Promise<Record<string, ToolDescriptor>> {
  const key = `${disc.endpoint}|${disc.agentProfileUrl}`
  const hit = toolsCache.get(key)
  if (!force && hit && Date.now() - hit.at < TOOLS_TTL_MS) return hit.value
  const info: RpcInfo = { profile: disc.agentProfileUrl }
  let result: { tools?: ToolDescriptor[] }
  try {
    result = await rpc<{ tools?: ToolDescriptor[] }>(
      disc.endpoint,
      'tools/list',
      { arguments: { meta: { 'ucp-agent': { profile: disc.agentProfileUrl } } } },
      0,
      info,
    )
  } catch (e) {
    if (e instanceof UcpError) recordSurface(disc.endpoint, 'tools/list', info.auth ?? authInfo('none'), false, e)
    throw e
  }
  const tools: Record<string, ToolDescriptor> = {}
  for (const t of result.tools ?? []) tools[t.name] = t
  toolsCache.set(key, { at: Date.now(), value: tools })
  return tools
}

// ─── tools/call ──────────────────────────────────────────────────────────────

export interface CallTrace {
  tool: string
  business: string
  endpoint: string
  durationMs: number
  /** PII-masked wire arguments. */
  request: unknown
  /** PII-masked unwrapped response. */
  response?: unknown
  error?: unknown
  validation?: ValidationReport
  /** Which identity path this request used (+ profile, token scopes/expiry). */
  auth?: AuthInfo
  surface?: Surface
  /** Agent profile sent in meta["ucp-agent"].profile. */
  profile?: string
  /** Where the payload came from: structuredContent or content[0].text. */
  payloadSource?: PayloadSource
  /** PII-masked raw MCP result (both renderings, as received). */
  raw?: unknown
}

export interface CallResult<T = Json> {
  data: T
  ucp?: UcpMeta
  isError: boolean
  trace: CallTrace
  discovered: Discovered
}

export interface CallOptions {
  /**
   * Send even if the payload has keys the live schema does not list.
   * ONLY used by the scenario-5 fault injection; everything else is strict.
   */
  allowUnknownFields?: boolean
}

export type PayloadSource = 'structuredContent' | 'content[0].text' | 'content[0].text (JSON değil)' | 'result'

/** Unwrap MCP `tools/call` → UCP payload (structuredContent preferred, else content[0].text JSON). */
export function unwrapToolResult(result: unknown): { payload: unknown; isError: boolean; source: PayloadSource } {
  if (typeof result !== 'object' || result === null) return { payload: result, isError: false, source: 'result' }
  const r = result as Json
  const isError = r.isError === true
  if (r.structuredContent && typeof r.structuredContent === 'object') return { payload: r.structuredContent, isError, source: 'structuredContent' }
  const first = Array.isArray(r.content) ? (r.content[0] as Json | undefined) : undefined
  if (first && typeof first.text === 'string') {
    try {
      return { payload: JSON.parse(first.text), isError, source: 'content[0].text' }
    } catch {
      return { payload: { text: first.text }, isError, source: 'content[0].text (JSON değil)' }
    }
  }
  return { payload: result, isError, source: 'result' }
}

/**
 * Raw MCP result for the debug panel with PII masked. Text renderings are
 * parsed and masked as JSON — masking the raw string would miss nested keys.
 */
export function maskRawResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result
  const r = result as Json
  const out: Json = { ...r }
  if (r.structuredContent) out.structuredContent = maskPII(r.structuredContent)
  if (Array.isArray(r.content)) {
    out.content = r.content.map((c) => {
      const item = c as Json
      if (typeof item?.text !== 'string') return item
      try {
        return { ...item, text: JSON.stringify(maskPII(JSON.parse(item.text))) }
      } catch {
        return { ...item, text: `[JSON olmayan metin, ${item.text.length} karakter — gizlilik için gösterilmiyor]` }
      }
    })
  }
  return out
}

export async function callTool<T = Json>(
  businessUrl: string,
  toolName: string,
  args: Json,
  opts: CallOptions = {},
): Promise<CallResult<T>> {
  if (FORBIDDEN_TOOLS.has(toolName)) {
    throw new UcpError({ kind: 'forbidden', message: `${toolName} bu prototipte kesinlikle çağrılmaz (sipariş oluşturur).` })
  }
  if (config().transport === 'cli') {
    const { callToolViaCli } = await import('./cli-adapter')
    return callToolViaCli<T>(businessUrl, toolName, args)
  }

  const disc = await discover(businessUrl)
  const surface = surfaceOf(disc.endpoint, toolName)
  const profile = await profileFor(surface)
  const tools = await listTools(disc)
  const tool = tools[toolName]
  if (!tool) {
    throw new UcpError({
      kind: 'not_offered',
      message: `${disc.business} "${toolName}" aracını sunmuyor.`,
      details: { offered: Object.keys(tools).sort() },
    })
  }

  // meta.idempotency-key only when the live schema accepts it. Observed live
  // (us.aabcollection.com search_catalog): `meta` is a closed object listing
  // only `ucp-agent`, so an unconditional key (what ucp-cli does) is rejected
  // by our pre-flight. Mutating tools on Shopify list it; read tools may not.
  const meta: Json = { ...((args.meta as Json) ?? {}), 'ucp-agent': { profile } }
  const schema = tool.inputSchema as Json
  const metaDescribed = pathStatus(schema, 'meta') === 'present'
  if (!metaDescribed || pathStatus(schema, 'meta.idempotency-key') !== 'absent') meta['idempotency-key'] = randomUUID()
  const wireArgs: Json = { ...args, meta }

  // UCP signals (dev.ucp.buyer_ip / dev.ucp.user_agent) only where the live
  // schema lists `<body>.signals` — Shopify enforces the header, not this.
  const bodyKey = ['checkout', 'cart'].find((k) => wireArgs[k] && typeof wireArgs[k] === 'object')
  let buyer: BuyerContext | undefined
  if (surface === 'checkout' && bodyKey && pathStatus(schema, `${bodyKey}.signals`) === 'present') {
    buyer = await buyerContext()
    const signals: Record<string, string> = {}
    if (buyer.ip) signals['dev.ucp.buyer_ip'] = buyer.ip
    if (buyer.userAgent) signals['dev.ucp.user_agent'] = buyer.userAgent
    if (Object.keys(signals).length) wireArgs[bodyKey] = { ...(wireArgs[bodyKey] as Json), signals }
  }

  // Rule 4: pre-flight against the live inputSchema.
  const validation = validate(tool.inputSchema, wireArgs)
  const trace: CallTrace = {
    tool: toolName,
    business: disc.business,
    endpoint: disc.endpoint,
    durationMs: 0,
    request: maskPII(wireArgs),
    validation,
    surface,
    profile,
  }
  const blocking = validation.valid === false || (validation.unknownFields.length > 0 && !opts.allowUnknownFields)
  if (blocking) {
    throw new UcpError({
      kind: 'schema',
      message:
        validation.unknownFields.length > 0
          ? `Şemada olmayan alan(lar): ${validation.unknownFields.map((u) => u.pointer).join(', ')} — gönderilmedi.`
          : `Şema doğrulaması başarısız: ${validation.errors.join('; ')}`,
      details: { validation, trace },
    })
  }

  const started = Date.now()
  const info: RpcInfo = { profile, buyer }
  try {
    const raw = await rpc(disc.endpoint, 'tools/call', { name: toolName, arguments: wireArgs }, 0, info)
    trace.auth = info.auth
    const { payload, isError, source } = unwrapToolResult(raw)
    trace.durationMs = Date.now() - started
    trace.response = maskPII(payload)
    trace.payloadSource = source
    trace.raw = maskRawResult(raw)
    const data = payload as Json
    // MCP `isError: true` is a tool-level failure. If it still carries a UCP
    // object (id / messages) keep it — business messages are handled by the
    // analysis layer. A bare error text is a protocol-level failure.
    const looksLikeUcp = data && typeof data === 'object' && ('id' in data || 'messages' in data || 'products' in data || 'product' in data)
    if (isError && !looksLikeUcp) {
      const text = typeof data?.text === 'string' ? data.text : JSON.stringify(data).slice(0, 300)
      throw new UcpError({ kind: 'jsonrpc', message: `MCP araç hatası (isError): ${text}`, data })
    }
    recordSurface(disc.endpoint, toolName, info.auth ?? authInfo('none', { profile }), true, undefined, trace.durationMs)
    return { data: data as T, ucp: data?.ucp as UcpMeta | undefined, isError, trace, discovered: disc }
  } catch (e) {
    trace.durationMs = Date.now() - started
    trace.auth = info.auth ?? authInfo('none', { profile })
    trace.error = e instanceof UcpError ? e.toJSON() : { message: (e as Error).message }
    if (e instanceof UcpError) recordSurface(disc.endpoint, toolName, trace.auth, false, e, trace.durationMs)
    if (e instanceof UcpError) e.details = { ...(e.details as Json), trace }
    throw e
  }
}

/** Live inputSchema of one tool on one business. */
export async function getInputSchema(businessUrl: string, toolName: string): Promise<unknown> {
  if (config().transport === 'cli') {
    const { inputSchemaViaCli } = await import('./cli-adapter')
    return inputSchemaViaCli(businessUrl, toolName)
  }
  const disc = await discover(businessUrl)
  const tools = await listTools(disc)
  if (!tools[toolName]) {
    throw new UcpError({ kind: 'not_offered', message: `${disc.business} "${toolName}" aracını sunmuyor.` })
  }
  return tools[toolName].inputSchema
}

export async function offeredTools(businessUrl: string): Promise<string[]> {
  if (config().transport === 'cli') return []
  const disc = await discover(businessUrl)
  return Object.keys(await listTools(disc)).sort()
}
