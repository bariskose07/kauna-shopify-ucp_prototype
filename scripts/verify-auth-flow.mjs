#!/usr/bin/env node
// Shopify "Authenticate your agent" — end-to-end verification, step by step.
//
//   node --env-file=.env scripts/verify-auth-flow.mjs [--seller https://us.aabcollection.com]
//        [--variant gid://shopify/ProductVariant/47830495854906] [--query "Green Tartan Maxi"]
//        [--email kauna-test@example.com] [--out verify-auth-report.md]
//
// 1. token (client_credentials) → scopes / exp / limits
// 2. Global Catalog search                  (Bearer, catalog profile)
// 3. merchant endpoint via /.well-known/ucp (fallback {merchant}/api/ucp/mcp)
// 4. create_cart                            (NO token, cart+checkout profile)
// 5. create_checkout with top-level cart_id (Bearer)
// 6. get_checkout → update_checkout PUT with buyer.email (Bearer)
// 7. every step: auth path + result; AuthenticationFailed reported explicitly,
//    never retried without the token
// 8. cancel_checkout                        (Bearer)
//
// complete_checkout is never called — the script refuses the name outright.
// Secrets: read from the environment only; the token is printed as 6 chars.
// Standalone on purpose (no app code) so it is an independent check of the
// header rules the app implements.

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
)
const SELLER = new URL(args.seller ?? process.env.DEFAULT_SELLER ?? 'https://us.aabcollection.com').origin
const VARIANT = args.variant ?? 'gid://shopify/ProductVariant/47830495854906'
const QUERY = args.query ?? 'Green Tartan Maxi'
const EMAIL = args.email ?? 'kauna-test@example.com'
const OUT = args.out ?? 'verify-auth-report.md'

const TOKEN_URL = process.env.SHOPIFY_AUTH_URL || 'https://api.shopify.com/auth/access_token'
const CATALOG_MCP = process.env.SHOPIFY_CATALOG_URL || 'https://catalog.shopify.com/api/ucp/mcp'
const CATALOG_ID = process.env.SHOPIFY_CATALOG_ID
const CATALOG_PROFILE = 'https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json'
const CART_CHECKOUT_PROFILE = process.env.VERIFY_CART_PROFILE || 'https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/cart-and-checkout.json'
const MCP_PROTOCOL_VERSION = '2026-03-26'
const FORBIDDEN = new Set(['complete_checkout'])

const mask6 = (s) => (s ? `${String(s).slice(0, 6)}…` : '—')
const maskEmail = (s) => String(s).replace(/^(.).*(@.*)$/, '$1***$2')
const steps = []
let token
let claims = {}

function step(n, title) {
  const s = { n, title, auth: '—', profile: '—', result: 'atlandı', detail: '' }
  steps.push(s)
  return s
}
function print(s) {
  const icon = s.result === 'ok' ? '✓' : s.result === 'atlandı' ? '·' : '✗'
  console.log(`${icon} ${s.n}. ${s.title}\n    kimlik: ${s.auth} · profil: ${s.profile}\n    sonuç: ${s.result}${s.detail ? ` — ${s.detail}` : ''}`)
}

// ── JSON-RPC with the header rules ──────────────────────────────────────────
let rpcId = 1
async function rpc(endpoint, method, params, { bearer }) {
  if (method === 'tools/call' && FORBIDDEN.has(params?.name)) throw new Error(`${params.name} bu betikte çağrılmaz`)
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    'User-Agent': 'kauna-verify-auth/0.1',
  }
  if (bearer) headers.Authorization = `Bearer ${token}`
  const id = rpcId++
  const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw Object.assign(new Error(`HTTP ${res.status}: JSON olmayan yanıt ${text.slice(0, 160)}`), { http: res.status })
  }
  if (res.status === 429) throw Object.assign(new Error(`HTTP 429 Retry-After=${res.headers.get('retry-after') ?? '?'}`), { http: 429 })
  if (body.error) {
    const msg = `JSON-RPC ${body.error.code}: ${body.error.message}${body.error.data ? ` ${JSON.stringify(body.error.data).slice(0, 200)}` : ''}`
    throw Object.assign(new Error(msg), { rpc: body.error, http: res.status })
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { http: res.status })
  return body.result
}

const isAuthFailure = (e) => e?.http === 401 || e?.http === 403 || /AuthenticationFailed|Unauthori[sz]ed|invalid[_ ]token/i.test(e?.message ?? '')

/** structuredContent first, else content[0].text JSON. */
function unwrap(result) {
  if (result?.structuredContent) return { payload: result.structuredContent, source: 'structuredContent' }
  const t = result?.content?.[0]?.text
  if (typeof t === 'string') {
    try {
      return { payload: JSON.parse(t), source: 'content[0].text' }
    } catch {
      return { payload: { text: t }, source: 'content[0].text (JSON değil)' }
    }
  }
  return { payload: result, source: 'result' }
}

// ── minimal schema reading (local $ref only) ────────────────────────────────
function deref(schema, root) {
  let s = schema
  for (let i = 0; i < 10 && s && typeof s === 'object' && typeof s.$ref === 'string' && s.$ref.startsWith('#/'); i++) {
    s = s.$ref.slice(2).split('/').reduce((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root)
  }
  return s
}
function propsAt(root, path) {
  let s = deref(root, root)
  for (const key of path) {
    const branches = [s, ...(s?.allOf ?? []), ...(s?.anyOf ?? []), ...(s?.oneOf ?? [])].map((x) => deref(x, root))
    s = branches.map((b) => (key === '[]' ? deref(b?.items, root) : deref(b?.properties?.[key], root))).find(Boolean)
    if (!s) return undefined
  }
  const branches = [s, ...(s?.allOf ?? []), ...(s?.anyOf ?? []), ...(s?.oneOf ?? [])].map((x) => deref(x, root))
  const keys = new Set(branches.flatMap((b) => Object.keys(b?.properties ?? {})))
  return keys
}
const metaFor = (schema, profile, mutating) => {
  const meta = { 'ucp-agent': { profile } }
  const m = propsAt(schema, ['meta'])
  if (mutating && (!m || m.size === 0 || m.has('idempotency-key'))) meta['idempotency-key'] = randomUUID()
  return meta
}

async function tools(endpoint, profile, bearer) {
  const r = await rpc(endpoint, 'tools/list', { arguments: { meta: { 'ucp-agent': { profile } } } }, { bearer })
  return Object.fromEntries((r.tools ?? []).map((t) => [t.name, t.inputSchema ?? {}]))
}

// ── run ─────────────────────────────────────────────────────────────────────
console.log(`Kauna × Shopify — kimlik doğrulama akışı doğrulaması\nmağaza: ${SELLER} · varyant: ${VARIANT}\n`)

// 1. token
const s1 = step(1, 'Token al (client_credentials)')
s1.auth = `POST ${new URL(TOKEN_URL).host}/auth/access_token`
const id = process.env.SHOPIFY_CLIENT_ID
const secret = process.env.SHOPIFY_CLIENT_SECRET
if (!id || !secret) {
  s1.result = 'HATA'
  s1.detail = 'SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET yok (node --env-file=.env ile çalıştırın)'
} else {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(30_000),
    })
    const b = await res.json().catch(() => ({}))
    if (!res.ok || !b.access_token) throw new Error(`HTTP ${res.status} ${[b.error, b.error_description ?? b.message].filter(Boolean).join(': ')}`)
    token = b.access_token
    try {
      claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    } catch {
      claims = {}
    }
    const scopes = Array.isArray(claims.scopes) ? claims.scopes : String(claims.scopes ?? claims.scope ?? b.scope ?? '').split(/[\s,]+/).filter(Boolean)
    s1.result = 'ok'
    s1.detail = `token=${mask6(token)} · scopes=[${scopes.join(' ')}] · exp=${claims.exp ? new Date(claims.exp * 1000).toISOString() : `~${b.expires_in ?? '?'} sn`}${claims.limits ? ` · limits=${JSON.stringify(claims.limits)}` : ''}`
  } catch (e) {
    s1.result = 'HATA'
    s1.detail = `Token alınamadı: ${e.message}`
  }
}
print(s1)

// 2. Global Catalog search
const s2 = step(2, `Global Catalog araması "${QUERY}"`)
s2.profile = CATALOG_PROFILE
if (!token) {
  s2.detail = 'token yok → Global Catalog çağrılmadı (token’sız yedek yok)'
} else {
  s2.auth = 'token (Bearer)'
  try {
    const t = await tools(CATALOG_MCP, CATALOG_PROFILE, true)
    const catalog = { query: QUERY, context: { address_country: 'US' }, pagination: { limit: 5 } }
    if (CATALOG_ID) catalog.catalog_id = CATALOG_ID
    const r = unwrap(
      await rpc(CATALOG_MCP, 'tools/call', { name: 'search_catalog', arguments: { meta: metaFor(t.search_catalog, CATALOG_PROFILE, false), catalog } }, { bearer: true }),
    )
    const products = r.payload.products ?? []
    s2.result = 'ok'
    s2.detail = `${products.length} ürün (${r.source})${CATALOG_ID ? ' · catalog.catalog_id gönderildi' : ''}${products[0] ? ` · ilk: ${products[0].title}` : ''}${(r.payload.messages ?? []).length ? ` · mesajlar: ${r.payload.messages.map((m) => m.code).join(',')}` : ''}`
  } catch (e) {
    s2.result = isAuthFailure(e) ? 'AuthenticationFailed' : 'HATA'
    s2.detail = e.message
  }
}
print(s2)

// 3. merchant endpoint
const s3 = step(3, `${new URL(SELLER).host} uç noktası (/.well-known/ucp)`)
s3.auth = 'yok (GET keşif)'
let MCP
try {
  const r = await fetch(`${SELLER}/.well-known/ucp`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  const j = await r.json()
  const raw = j?.ucp?.services?.['dev.ucp.shopping']
  const entries = Array.isArray(raw) ? raw : raw?.mcp ? [{ transport: 'mcp', ...raw.mcp }] : []
  MCP = entries.find((e) => e.transport === 'mcp')?.endpoint
  if (!MCP) throw new Error(`MCP girişi yok (HTTP ${r.status})`)
  s3.result = 'ok'
  s3.detail = `${MCP} (UCP ${j.ucp.version ?? '?'})`
} catch (e) {
  MCP = `${SELLER}/api/ucp/mcp`
  s3.result = 'ok'
  s3.detail = `keşif okunamadı (${e.message}) → yedek ${MCP}`
}
print(s3)

// 4. create_cart — no token
const s4 = step(4, 'create_cart')
s4.auth = 'token yok – tasarım gereği'
s4.profile = CART_CHECKOUT_PROFILE
let merchantTools = {}
let cartId
try {
  merchantTools = await tools(MCP, CART_CHECKOUT_PROFILE, false)
  const schema = merchantTools.create_cart
  if (!schema) throw new Error(`create_cart sunulmuyor (araçlar: ${Object.keys(merchantTools).join(', ')})`)
  const cart = { line_items: [{ quantity: 1, item: { id: VARIANT } }] }
  if (propsAt(schema, ['cart'])?.has('context')) cart.context = { address_country: 'US' }
  const r = unwrap(await rpc(MCP, 'tools/call', { name: 'create_cart', arguments: { meta: metaFor(schema, CART_CHECKOUT_PROFILE, true), cart } }, { bearer: false }))
  const c = r.payload.cart ?? r.payload
  cartId = c.id
  if (!cartId) throw new Error(`yanıtta cart id yok: ${JSON.stringify(r.payload).slice(0, 200)}`)
  s4.result = 'ok'
  s4.detail = `cart_id=${mask6(cartId.split('/').pop())} (${r.source})${(c.messages ?? []).length ? ` · mesajlar: ${c.messages.map((m) => `${m.code}/${m.severity}`).join(',')}` : ''}`
} catch (e) {
  s4.result = 'HATA'
  s4.detail = e.message
}
print(s4)

// 5. create_checkout with top-level cart_id — token
const s5 = step(5, 'create_checkout (üst düzey cart_id)')
s5.profile = CART_CHECKOUT_PROFILE
let checkout
if (!cartId) s5.detail = 'sepet yok'
else if (!token) s5.detail = 'token yok → checkout çağrılmadı (token’sız yedek yok)'
else {
  s5.auth = 'token (Bearer)'
  try {
    const schema = merchantTools.create_checkout
    if (!schema) throw new Error('create_checkout sunulmuyor')
    const top = propsAt(schema, [])
    const inner = propsAt(schema, ['checkout']) ?? new Set()
    const argsC = { meta: metaFor(schema, CART_CHECKOUT_PROFILE, true) }
    let where
    if (top?.has('cart_id')) {
      argsC.cart_id = cartId
      argsC.checkout = { line_items: [{ quantity: 1, item: { id: VARIANT } }] }
      where = 'üst düzey cart_id'
    } else if (inner.has('cart_id')) {
      argsC.checkout = { cart_id: cartId, line_items: [] }
      where = 'checkout.cart_id (şema üst düzeyi listelemiyor)'
    } else {
      argsC.cart_id = cartId
      argsC.checkout = { line_items: [{ quantity: 1, item: { id: VARIANT } }] }
      where = 'üst düzey cart_id (şemada listelenmiyor — resmi desen)'
    }
    const r = unwrap(await rpc(MCP, 'tools/call', { name: 'create_checkout', arguments: argsC }, { bearer: true }))
    checkout = r.payload.checkout ?? r.payload
    if (!checkout.id) throw new Error(`yanıtta checkout id yok: ${JSON.stringify(r.payload).slice(0, 200)}`)
    s5.result = 'ok'
    s5.detail = `${where} · status=${checkout.status} · id=${mask6(String(checkout.id).split('/').pop())} (${r.source})${(checkout.messages ?? []).length ? ` · mesajlar: ${checkout.messages.map((m) => `${m.code}/${m.severity}`).join(',')}` : ''}`
  } catch (e) {
    s5.result = isAuthFailure(e) ? 'AuthenticationFailed' : 'HATA'
    s5.detail = e.message
  }
}
print(s5)

// 6. get_checkout → update_checkout (PUT) with buyer.email — token
const s6 = step(6, 'get_checkout → update_checkout (buyer.email, PUT)')
s6.profile = CART_CHECKOUT_PROFILE
if (!checkout?.id) s6.detail = 'checkout yok'
else {
  s6.auth = 'token (Bearer)'
  try {
    const g = unwrap(
      await rpc(MCP, 'tools/call', { name: 'get_checkout', arguments: { meta: metaFor(merchantTools.get_checkout, CART_CHECKOUT_PROFILE, false), id: checkout.id } }, { bearer: true }),
    )
    const cur = g.payload.checkout ?? g.payload
    const schema = merchantTools.update_checkout
    const allowed = propsAt(schema, ['checkout']) ?? new Set()
    const lineKeys = propsAt(schema, ['checkout', 'line_items', '[]']) ?? new Set()
    const body = {}
    const skipped = []
    const put = (k, v) => (allowed.size === 0 || allowed.has(k) ? (body[k] = v) : skipped.push(k))
    if (cur.currency) put('currency', cur.currency)
    if (cur.context) put('context', cur.context)
    put(
      'line_items',
      (cur.line_items ?? []).map((l) => ({ ...(lineKeys.has('id') && l.id ? { id: l.id } : {}), quantity: l.quantity, item: { id: l.item?.id } })),
    )
    put('buyer', { ...(cur.buyer ?? {}), email: EMAIL })
    const r = unwrap(
      await rpc(
        MCP,
        'tools/call',
        { name: 'update_checkout', arguments: { meta: metaFor(schema, CART_CHECKOUT_PROFILE, true), id: checkout.id, checkout: body } },
        { bearer: true },
      ),
    )
    checkout = r.payload.checkout ?? r.payload
    const msgs = (checkout.messages ?? []).map((m) => `${m.code}/${m.severity ?? m.type}`)
    const warn = msgs.filter((m) => /buyer_identity_contact_method_required|delivery_address_required/.test(m))
    s6.result = 'ok'
    s6.detail = `status=${checkout.status} · buyer.email=${checkout.buyer?.email ? maskEmail(checkout.buyer.email) : 'YANSIMADI'}${skipped.length ? ` · şemada yok, gönderilmedi: ${skipped.join(',')}` : ''}${msgs.length ? ` · mesajlar: ${msgs.join(',')}` : ''}${warn.length ? ' · ⚠ alıcı/adres eksik uyarısı' : ''}${checkout.continue_url ? ` · continue_url host=${new URL(checkout.continue_url).host}` : ''}`
  } catch (e) {
    s6.result = isAuthFailure(e) ? 'AuthenticationFailed' : 'HATA'
    s6.detail = e.message
  }
}
print(s6)

// 7 is the per-step reporting above; 8. cancel_checkout — token
const s8 = step(8, 'cancel_checkout')
s8.profile = CART_CHECKOUT_PROFILE
if (!checkout?.id) s8.detail = 'checkout yok'
else if (!merchantTools.cancel_checkout) s8.detail = 'cancel_checkout sunulmuyor (tools/list)'
else {
  s8.auth = 'token (Bearer)'
  try {
    const r = unwrap(
      await rpc(MCP, 'tools/call', { name: 'cancel_checkout', arguments: { meta: metaFor(merchantTools.cancel_checkout, CART_CHECKOUT_PROFILE, true), id: checkout.id } }, { bearer: true }),
    )
    const c = r.payload.checkout ?? r.payload
    s8.result = 'ok'
    s8.detail = `status=${c.status ?? '?'}`
  } catch (e) {
    s8.result = isAuthFailure(e) ? 'AuthenticationFailed' : 'HATA'
    s8.detail = e.message
  }
}
print(s8)

// ── report ──────────────────────────────────────────────────────────────────
const rows = steps.map((s) => `| ${s.n} | ${s.title} | ${s.auth} | ${s.result} | ${String(s.detail).replaceAll('|', '\\|')} |`)
const md = [
  `### Kimlik doğrulama akışı — ${new Date().toISOString()}`,
  '',
  `Mağaza \`${SELLER}\` · varyant \`${VARIANT}\` · MCP-Protocol-Version \`${MCP_PROTOCOL_VERSION}\``,
  `Profiller: katalog \`${CATALOG_PROFILE}\`, sepet/checkout \`${CART_CHECKOUT_PROFILE}\``,
  '',
  '| # | Adım | Kimlik yolu | Sonuç | Ayrıntı |',
  '| --- | --- | --- | --- | --- |',
  ...rows,
  '',
  'complete_checkout çağrılmadı. Token yalnızca ilk 6 karakteriyle gösterildi; e-posta maskeli.',
].join('\n')
writeFileSync(OUT, md + '\n')
console.log(`\nRapor: ${OUT} (FINDINGS.md §13'e yapıştırılabilir)`)
process.exit(steps.some((s) => s.result !== 'ok' && s.result !== 'atlandı') ? 1 : 0)
