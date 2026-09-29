// UCP transport: discovery, auth, JSON-RPC 2.0 over HTTPS, error separation.
//
// Auth path (see README "Kimlik doğrulama"):
//   1. SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET → bearer token from
//      https://api.shopify.com/auth/access_token (cached ~60 min).
//   2. Otherwise → exactly what @shopify/ucp-cli does. Reading its source
//      (src/core/mcp-client.ts, operation.ts) shows there is NO request signing:
//      the agent's identity is the profile URL sent in
//      `params.arguments.meta["ucp-agent"].profile`, which the business fetches
//      to negotiate. We replicate that byte-for-byte.
//   3. UCP_TRANSPORT=cli → shell out to the CLI (cli-adapter.ts).
//
// Server-only module: never import from a client component.

import { randomUUID } from 'node:crypto'

import { maskPII } from '../mask'
import { UcpError, parseRetryAfter } from './errors'
import { pathStatus, validate, type ValidationReport } from './schema'
import type { Json, UcpMeta } from './types'

// ─── safety rail (rule 1) ────────────────────────────────────────────────────
// No code path in this prototype may place an order. The tool name is refused
// here, at the single choke point every UCP call goes through.
const FORBIDDEN_TOOLS: ReadonlySet<string> = new Set(['complete_checkout'])

export const SUPPORTED_VERSIONS = ['2026-08-25', '2026-04-08'] as const
const SHOPIFY_SAMPLE_PROFILE = (v: string) =>
  `https://shopify.dev/ucp/agent-profiles/${v}/valid-with-capabilities.json`

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

export function config() {
  return {
    transport: (process.env.UCP_TRANSPORT ?? 'auto') === 'cli' ? ('cli' as const) : ('direct' as const),
    hasClientCredentials: Boolean(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET),
    profileOverride: process.env.UCP_AGENT_PROFILE_URL || undefined,
    // SHOPIFY_CATALOG_URL (Dev Dashboard) is the MCP endpoint itself, e.g.
    // https://catalog.shopify.com/api/ucp/mcp; its origin is the catalog business.
    catalogUrl: catalogEndpoint() ? new URL(catalogEndpoint() as string).origin : process.env.UCP_CATALOG_URL || 'https://catalog.shopify.com',
    catalogEndpoint: catalogEndpoint(),
    /** Dev Dashboard catalog id — sent as `saved_catalog_slug` (see catalog.ts). */
    catalogId: process.env.SHOPIFY_CATALOG_ID || undefined,
    defaultSeller: process.env.DEFAULT_SELLER || 'https://us.aabcollection.com',
    maxRetryAfter: Number(process.env.UCP_MAX_RETRY_AFTER_SECONDS ?? 5),
  }
}

// ─── auth: client-credentials token (path 1) ────────────────────────────────

const g = globalThis as unknown as {
  __ucpToken?: { token: string; expiresAt: number }
  __ucpDisc?: Map<string, { at: number; value: Discovered }>
  __ucpTools?: Map<string, { at: number; value: Record<string, ToolDescriptor> }>
}
const discCache = (g.__ucpDisc ??= new Map())
const toolsCache = (g.__ucpTools ??= new Map())

export async function getAccessToken(): Promise<string | undefined> {
  const id = process.env.SHOPIFY_CLIENT_ID
  const secret = process.env.SHOPIFY_CLIENT_SECRET
  if (!id || !secret) return undefined
  const cached = g.__ucpToken
  // Refresh 5 minutes early; tokens are documented as valid for 60 minutes.
  if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token
  let res: Response
  try {
    res = await fetch('https://api.shopify.com/auth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    // Network failure, not bad credentials.
    throw new UcpError({ kind: 'network', message: `api.shopify.com token isteğine ulaşılamadı: ${(e as Error).message}` })
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
  if (!res.ok || !body.access_token) {
    // Never echo the response body: it may contain the credentials' context.
    throw new UcpError({ kind: 'auth', httpStatus: res.status, message: `Token alınamadı (HTTP ${res.status})` })
  }
  g.__ucpToken = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  }
  return body.access_token
}

// ─── discovery ───────────────────────────────────────────────────────────────

export interface Discovered {
  business: string
  version: string
  source: 'well-known' | 'supported_versions'
  businessProfileUrl: string
  endpoint: string
  agentProfileUrl: string
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
      agentProfileUrl: config().profileOverride ?? SHOPIFY_SAMPLE_PROFILE(version),
      capabilities: base?.capabilities,
      paymentHandlers: base?.paymentHandlers,
      profile: base?.profile ?? {},
    }
    discCache.set(origin, { at: Date.now(), value })
    return value
  }
  const value = await discoverWellKnown(origin)
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
    agentProfileUrl: config().profileOverride ?? SHOPIFY_SAMPLE_PROFILE(version),
    capabilities: ucp.capabilities,
    paymentHandlers: ucp.payment_handlers,
    profile,
  }
  return value
}

// ─── JSON-RPC ────────────────────────────────────────────────────────────────

let rpcId = 1

/**
 * The Dev Dashboard token is a *Catalog* credential. Observed live
 * (2026-09-29): sending it to a merchant's Checkout MCP endpoint
 * (aab-usa-v2.myshopify.com) returns JSON-RPC -32000 "AuthenticationFailed",
 * while the same calls without it work (ucp-cli never sends one to merchants).
 * So only the catalog endpoint gets it, unless SHOPIFY_TOKEN_FOR_MERCHANTS=1.
 */
export function shouldSendToken(endpoint: string): boolean {
  if (process.env.SHOPIFY_TOKEN_FOR_MERCHANTS === '1') return true
  return new URL(endpoint).origin === new URL(config().catalogUrl).origin
}

async function authHeaders(endpoint: string): Promise<Record<string, string>> {
  if (!shouldSendToken(endpoint)) return {}
  const token = await getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * One JSON-RPC call. Protocol failures throw UcpError; a successful `result`
 * is returned untouched (business messages inside it are NOT errors).
 * HTTP 429 → wait `Retry-After` once when it is short, otherwise surface it.
 */
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

export async function rpc<T = unknown>(endpoint: string, method: string, params: unknown, attempt = 0): Promise<T> {
  const left = rateLimitRemaining(endpoint)
  if (left !== undefined) {
    throw new UcpError({
      kind: 'rate_limited',
      httpStatus: 429,
      retryAfterSeconds: left,
      message: `Hız limiti sürüyor (${Math.ceil(left / 60)} dk kaldı). Süre bitene kadar bu uç noktaya istek gönderilmiyor.`,
    })
  }
  const id = rpcId++
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(await authHeaders(endpoint)),
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
      return rpc<T>(endpoint, method, params, attempt + 1)
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
  const result = await rpc<{ tools?: ToolDescriptor[] }>(disc.endpoint, 'tools/list', {
    arguments: { meta: { 'ucp-agent': { profile: disc.agentProfileUrl } } },
  })
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

/** Unwrap MCP `tools/call` → UCP payload (structuredContent preferred). */
export function unwrapToolResult(result: unknown): { payload: unknown; isError: boolean } {
  if (typeof result !== 'object' || result === null) return { payload: result, isError: false }
  const r = result as Json
  const isError = r.isError === true
  if (r.structuredContent && typeof r.structuredContent === 'object') return { payload: r.structuredContent, isError }
  const first = Array.isArray(r.content) ? (r.content[0] as Json | undefined) : undefined
  if (first && typeof first.text === 'string') {
    try {
      return { payload: JSON.parse(first.text), isError }
    } catch {
      return { payload: { text: first.text }, isError }
    }
  }
  return { payload: result, isError }
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
  const meta: Json = { ...((args.meta as Json) ?? {}), 'ucp-agent': { profile: disc.agentProfileUrl } }
  const schema = tool.inputSchema as Json
  const metaDescribed = pathStatus(schema, 'meta') === 'present'
  if (!metaDescribed || pathStatus(schema, 'meta.idempotency-key') !== 'absent') meta['idempotency-key'] = randomUUID()
  const wireArgs: Json = { ...args, meta }

  // Rule 4: pre-flight against the live inputSchema.
  const validation = validate(tool.inputSchema, wireArgs)
  const trace: CallTrace = {
    tool: toolName,
    business: disc.business,
    endpoint: disc.endpoint,
    durationMs: 0,
    request: maskPII(wireArgs),
    validation,
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
  try {
    const raw = await rpc(disc.endpoint, 'tools/call', { name: toolName, arguments: wireArgs })
    const { payload, isError } = unwrapToolResult(raw)
    trace.durationMs = Date.now() - started
    trace.response = maskPII(payload)
    const data = payload as Json
    return { data: data as T, ucp: data?.ucp as UcpMeta | undefined, isError, trace, discovered: disc }
  } catch (e) {
    trace.durationMs = Date.now() - started
    trace.error = e instanceof UcpError ? e.toJSON() : { message: (e as Error).message }
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
