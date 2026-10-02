#!/usr/bin/env node
// Local mock UCP business for offline development / UI smoke tests.
// NOT a Shopify replica — it imitates the behaviours we care about:
//   - /.well-known/ucp → dev.ucp.shopping over MCP
//   - tools/list with inputSchemas (phone lives on the delivery destination)
//   - create/update/get checkout; carts
//   - no phone      → incomplete + delivery_phone_number_required (recoverable)
//   - with phone    → requires_escalation + extension_interaction_required
//   - unknown destination key → destination silently ignored (the incident)
//   - discount code KAUNA10 → 10 % applied; anything else → warning message
//   - complete_checkout is not even listed.
//   - auth like Shopify's flow: POST /auth/access_token issues a fake JWT;
//     checkout tools REQUIRE `Authorization: Bearer`; cart tools REJECT one
//     (so a client that sends the token to the wrong surface fails loudly);
//     every JSON-RPC request must carry MCP-Protocol-Version.
//     Checkout tools also need `Shopify-Buyer-IP` (422 "Missing required buyer IP header." like live).
//     MOCK_REJECT_TOKEN=1 → checkout answers -32000 AuthenticationFailed.
//   - create_checkout takes a top-level cart_id (cart content wins).
//
// Catalog stand-in: run a second instance with MOCK_PORT=8444
// MOCK_SELLER_PORT=8443 and point SHOPIFY_CATALOG_URL at it.
//
// Usage (needs a TLS cert because the app only talks https):
//   MOCK_TLS_CERT=cert.pem MOCK_TLS_KEY=key.pem node scripts/mock-ucp-server.mjs
//   NODE_EXTRA_CA_CERTS=cert.pem npm run dev   → seller "localhost:8443"

import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.MOCK_PORT ?? 8443)
const ORIGIN = `https://localhost:${PORT}`
// Products returned by this instance belong to this seller (a catalog
// instance on another port still points buyers at the merchant).
const SELLER_PORT = Number(process.env.MOCK_SELLER_PORT ?? PORT)
const V = '2026-04-08'

const postal = {
  type: 'object',
  properties: Object.fromEntries(
    ['first_name', 'last_name', 'street_address', 'address_locality', 'address_region', 'postal_code', 'address_country', 'phone_number'].map((k) => [
      k,
      { type: 'string' },
    ]),
  ),
}
const checkoutBody = {
  type: 'object',
  properties: {
    currency: { type: 'string' },
    line_items: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, item: { type: 'object', properties: { id: { type: 'string' } } }, quantity: { type: 'integer' } } },
    },
    buyer: { type: 'object', properties: { email: { type: 'string' }, first_name: { type: 'string' }, last_name: { type: 'string' } } },
    fulfillment: {
      type: 'object',
      properties: {
        methods: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              line_item_ids: { type: 'array', items: { type: 'string' } },
              destinations: { type: 'array', items: postal },
              groups: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, selected_option_id: { type: 'string' } } } },
            },
          },
        },
      },
    },
    discounts: { type: 'object', properties: { codes: { type: 'array', items: { type: 'string' } } } },
    attribution: { type: 'object', additionalProperties: { type: 'string' } },
    context: { type: 'object', properties: { address_country: { type: 'string' } } },
  },
}
const cartBody = {
  type: 'object',
  properties: { line_items: checkoutBody.properties.line_items, context: checkoutBody.properties.context, fulfillment: checkoutBody.properties.fulfillment },
}
const meta = { type: 'object' }
const tools = [
  { name: 'create_cart', inputSchema: { type: 'object', properties: { meta, cart: cartBody } } },
  { name: 'update_cart', inputSchema: { type: 'object', properties: { meta, id: { type: 'string' }, cart: cartBody } } },
  { name: 'get_cart', inputSchema: { type: 'object', properties: { meta, id: { type: 'string' } } } },
  { name: 'cancel_cart', inputSchema: { type: 'object', properties: { meta, id: { type: 'string' } } } },
  { name: 'create_checkout', inputSchema: { type: 'object', properties: { meta, cart_id: { type: 'string' }, checkout: checkoutBody } } },
  { name: 'cancel_checkout', inputSchema: { type: 'object', properties: { meta, id: { type: 'string' } } } },
  { name: 'update_checkout', inputSchema: { type: 'object', properties: { meta, id: { type: 'string' }, checkout: checkoutBody } } },
  { name: 'get_checkout', inputSchema: { type: 'object', properties: { meta, id: { type: 'string' } } } },
  { name: 'search_catalog', inputSchema: { type: 'object', properties: { meta: { type: 'object', properties: { 'ucp-agent': { type: 'object' } } }, catalog: { type: 'object', properties: { query: { type: 'string' }, context: { type: 'object' }, pagination: { type: 'object' }, filters: { type: 'object' } } } } } },
  { name: 'get_product', inputSchema: { type: 'object', properties: { meta, catalog: { type: 'object', properties: { id: { type: 'string' }, selected: { type: 'array' }, preferences: { type: 'array' }, context: { type: 'object' } } } } } },
  { name: 'lookup_catalog', inputSchema: { type: 'object', properties: { meta, catalog: { type: 'object', properties: { ids: { type: 'array' }, filters: { type: 'object' }, context: { type: 'object' } } } } } },
]

function toolsWithoutExtensions() {
  return tools.map((t) => {
    const body = t.inputSchema.properties.checkout
    if (!body) return t
    const { fulfillment: _f, discounts: _d, ...rest } = body.properties
    return { ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, checkout: { ...body, properties: rest } } } }
  })
}

const PRICE = 13400

// ── catalog (so the whole UI can be exercised offline) ──────────────────────
const HOST = `localhost:${SELLER_PORT}`
const IMG = (c) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='600' height='800'><rect width='600' height='800' fill='${c}'/><text x='300' y='420' font-size='40' text-anchor='middle' fill='white' font-family='sans-serif'>mock</text></svg>`)}`
const seller = { name: 'Aab (mock)', domain: HOST, url: `https://${HOST}`, id: 'gid://shopify/Shop/1' }
const mkVariant = (id, length, size, available = true) => ({
  id: `gid://shopify/ProductVariant/${id}`,
  title: `${length} / ${size}`,
  price: { amount: PRICE, currency: 'USD' },
  availability: { available, status: available ? 'in_stock' : 'out_of_stock' },
  eligible: { native_checkout: false },
  requires: { shipping: true },
  options: [{ name: 'Dress length', label: length }, { name: 'Size', label: size }],
  seller,
  url: `https://${HOST}/products/green-tartan-maxi`,
  checkout_url: `https://${HOST}/cart/${id}:1`,
})
const PRODUCT = {
  id: 'gid://shopify/p/mock1',
  title: 'Green Tartan Maxi',
  description: { plain: 'Mock product for offline UI tests.' },
  url: `https://${HOST}/products/green-tartan-maxi`,
  media: [{ url: IMG('#4a5a3a'), alt_text: 'front' }, { url: IMG('#6b5a3a'), alt_text: 'back' }],
  price_range: { min: { amount: PRICE, currency: 'USD' }, max: { amount: PRICE, currency: 'USD' } },
  options: [
    { name: 'Dress length', values: [{ label: '52 in', available: true, exists: true }, { label: '54 in', available: true, exists: true }] },
    { name: 'Size', values: [{ label: 'XXS', available: true, exists: true }, { label: 'XS', available: false, exists: true }] },
  ],
  variants: [mkVariant(1001, '52 in', 'XXS'), mkVariant(1002, '54 in', 'XXS'), mkVariant(1003, '52 in', 'XS', false)],
}
const PRODUCT2 = { ...PRODUCT, id: 'gid://shopify/p/mock2', title: 'Summer Tweed Maxi', media: [{ url: IMG('#7a6a55') }], variants: [mkVariant(2001, '52 in', 'XXS')], options: [] }
// Search results deliberately omit variants[].seller on the 2nd product
// (seen live: seller not always on every variant) → exercises the fallback.
const searchProducts = () => [PRODUCT, { ...PRODUCT2, seller, variants: PRODUCT2.variants.map(({ seller: _s, ...v }) => v) }]
const carts = new Map()
const checkouts = new Map()
const ucpMeta = {
  version: V,
  capabilities: { 'dev.ucp.shopping.checkout': [{ version: V }], 'dev.ucp.shopping.fulfillment': [{ version: V }], 'dev.ucp.shopping.discount': [{ version: V }] },
  payment_handlers: { 'dev.shopify.card': [{ id: 'card', version: V }], 'dev.shopify.shop_pay': [{ id: 'shop_pay', version: V }] },
}

function lines(reqLines, prev = []) {
  return reqLines.map((l, i) => ({
    id: l.id ?? prev[i]?.id ?? `li_${randomUUID().slice(0, 6)}`,
    item: { id: l.item.id, title: 'Green Tartan Maxi (mock)', price: PRICE },
    quantity: l.quantity,
    totals: [{ type: 'total', amount: PRICE * l.quantity }],
  }))
}

function render(co) {
  const sub = co.line_items.reduce((a, l) => a + PRICE * l.quantity, 0)
  const messages = []
  const totals = [{ type: 'subtotal', amount: sub, display_text: 'Subtotal' }]
  const dest = co.destination
  let methods = []
  if (dest) {
    const sel = co.selected ?? 'std'
    methods = [
      {
        id: 'm_1',
        type: 'shipping',
        line_item_ids: co.line_items.map((l) => l.id),
        destinations: [{ id: 'd_1', ...dest }],
        groups: [
          {
            id: 'g_1',
            selected_option_id: sel,
            options: [
              { id: 'std', title: 'Standard', totals: [{ type: 'total', amount: 1490 }], earliest_fulfillment_time: new Date(Date.now() + 4 * 864e5).toISOString(), latest_fulfillment_time: new Date(Date.now() + 7 * 864e5).toISOString() },
              { id: 'exp', title: 'Express', totals: [{ type: 'total', amount: 2990 }], earliest_fulfillment_time: new Date(Date.now() + 2 * 864e5).toISOString() },
            ],
          },
        ],
      },
    ]
    totals.push({ type: 'fulfillment', amount: sel === 'exp' ? 2990 : 1490, display_text: 'Shipping' })
  }
  let discount = 0
  const applied = []
  for (const c of co.codes ?? []) {
    if (c.toUpperCase() === 'KAUNA10') {
      discount = Math.round(sub * 0.1)
      applied.push({ code: c, title: 'Kauna 10%', amount: discount })
    } else messages.push({ type: 'warning', code: 'discount_code_invalid', content: `Enter a valid discount code (${c})`, path: '$.discounts.codes' })
  }
  if (discount) totals.push({ type: 'discount', amount: -discount, display_text: 'Discount' })
  totals.push({ type: 'tax', amount: 0, display_text: 'Tax' })
  totals.push({ type: 'total', amount: totals.reduce((a, t) => a + t.amount, 0), display_text: 'Total' })
  let status = 'incomplete'
  if (dest && !dest.phone_number) {
    messages.push({ type: 'error', code: 'delivery_phone_number_required', severity: 'recoverable', content: 'Phone number is required for delivery', path: '$.fulfillment.methods[0].destinations[0].phone_number' })
  } else if (dest) {
    status = 'requires_escalation'
    messages.push({ type: 'error', code: 'extension_interaction_required', severity: 'requires_buyer_input', content: 'This store requires interaction with a checkout extension.' })
  }
  return {
    ucp: ucpMeta,
    id: co.id,
    status,
    currency: 'USD',
    buyer: co.buyer,
    line_items: co.line_items,
    totals,
    messages,
    fulfillment: { methods },
    discounts: { codes: co.codes ?? [], applied },
    attribution: co.attribution,
    links: [
      { type: 'privacy_policy', url: `${ORIGIN}/policies/privacy`, title: 'Privacy' },
      { type: 'terms_of_service', url: `${ORIGIN}/policies/terms`, title: 'Terms' },
      { type: 'refund_policy', url: `${ORIGIN}/policies/refund`, title: 'Refunds' },
    ],
    continue_url: `${ORIGIN}/checkouts/cn/${co.id.split('/').pop().split('?')[0]}?key=${'c'.repeat(40)}`,
  }
}

function applyCheckout(co, body, cartId) {
  if (cartId && carts.has(cartId)) co.line_items = carts.get(cartId).line_items
  else if (body.line_items?.length) co.line_items = lines(body.line_items, co.line_items)
  co.buyer = body.buyer
  co.codes = body.discounts?.codes
  co.attribution = body.attribution ?? co.attribution
  const m = body.fulfillment?.methods?.[0]
  const d = m?.destinations?.[0]
  // The incident: an unknown key → whole destination silently ignored.
  const known = new Set(Object.keys(postal.properties))
  co.destination = d && Object.keys(d).every((k) => known.has(k)) ? d : undefined
  co.selected = m?.groups?.[0]?.selected_option_id
}

function call(name, a) {
  switch (name) {
    case 'create_cart': {
      const id = `gid://shopify/Cart/${randomUUID().slice(0, 8)}`
      const cart = { id, line_items: lines(a.cart.line_items) }
      carts.set(id, cart)
      const dest = a.cart.fulfillment?.methods?.[0]?.destinations?.[0]
      const totals = [{ type: 'subtotal', amount: PRICE }]
      if (dest) totals.push({ type: 'fulfillment', amount: 1490, display_text: 'Shipping (estimate)' })
      totals.push({ type: 'total', amount: totals.reduce((x, t) => x + t.amount, 0) })
      return { ucp: ucpMeta, ...cart, currency: 'USD', totals, fulfillment: dest ? { methods: [{ type: 'shipping', destinations: [dest], groups: [{ id: 'g_1', selected_option_id: 'std', options: [{ id: 'std', title: 'Standard', totals: [{ type: 'total', amount: 1490 }] }] }] }] } : undefined }
    }
    case 'get_cart': {
      const cart = carts.get(a.id)
      return cart ? { ucp: ucpMeta, ...cart, currency: 'USD' } : null
    }
    case 'cancel_cart': {
      carts.delete(a.id)
      return { ucp: ucpMeta, id: a.id, status: 'canceled' }
    }
    case 'update_cart': {
      const cart = carts.get(a.id)
      cart.line_items = lines(a.cart.line_items, cart.line_items)
      const sub = cart.line_items.reduce((x, l) => x + PRICE * l.quantity, 0)
      return { ucp: ucpMeta, ...cart, currency: 'USD', totals: [{ type: 'subtotal', amount: sub }, { type: 'total', amount: sub }] }
    }
    case 'create_checkout': {
      // Real shape: gid://shopify/Checkout/{TOKEN}?key={32-char KEY}
      const co = { id: `gid://shopify/Checkout/hWN${randomUUID().replaceAll('-', '').slice(0, 20)}?key=${randomUUID().replaceAll('-', '')}`, line_items: [] }
      applyCheckout(co, a.checkout, a.cart_id)
      checkouts.set(co.id, co)
      return render(co)
    }
    case 'update_checkout': {
      const co = checkouts.get(a.id)
      applyCheckout(co, a.checkout)
      return render(co)
    }
    case 'get_checkout':
      return render(checkouts.get(a.id))
    case 'cancel_checkout': {
      const co = checkouts.get(a.id)
      co.canceled = true
      return { ...render(co), status: 'canceled' }
    }
    case 'search_catalog':
      return { ucp: ucpMeta, products: searchProducts().filter((p) => p.title.toLowerCase().includes(String(a.catalog.query ?? '').toLowerCase().split(' ')[0] ?? '')) }
    case 'lookup_catalog':
      return { ucp: ucpMeta, products: [PRODUCT] }
    case 'get_product': {
      const sel = a.catalog.selected ?? []
      const p = a.catalog.id === PRODUCT2.id ? PRODUCT2 : PRODUCT
      const match = p.variants.filter((v) => sel.every((s) => v.options.some((o) => o.name === s.name && o.label === s.label)))
      return { ucp: ucpMeta, product: { ...p, selected: sel.length ? sel : p.variants[0].options, variants: match.length ? match : p.variants } }
    }
    default:
      return null
  }
}

// ── storefront (for the mobile harness) ─────────────────────────────────────
// A minimal Shopify-like storefront keyed by the `cart` cookie
// ("{token}%3Fkey%3D{key}"), plus a stand-in for UpPromote's theme script:
// when a product page is opened with ?sca_ref, the PAGE writes
// attributes._up_click_id into the current cart. This exists only in the mock
// so the harness's cookie/poll/restore logic can be exercised offline.
const sfCarts = new Map() // token -> { token, key, attributes, items }
function sfCartFromCookie(req, res) {
  const raw = /(?:^|; )cart=([^;]*)/.exec(req.headers.cookie ?? '')?.[1]
  const dec = raw ? decodeURIComponent(raw) : ''
  const [token, key] = dec.split('?key=')
  if (token) {
    if (!sfCarts.has(token)) sfCarts.set(token, { token, key: key ?? '', attributes: {}, items: [] })
    return sfCarts.get(token)
  }
  const c = { token: `sf${randomUUID().replaceAll('-', '').slice(0, 18)}`, key: randomUUID().replaceAll('-', ''), attributes: {}, items: [] }
  sfCarts.set(c.token, c)
  res.setHeader('Set-Cookie', `cart=${c.token}%3Fkey%3D${c.key}; Path=/; SameSite=Lax`)
  return c
}
const sfJson = (c) => ({ token: `${c.token}?key=${c.key}`, attributes: c.attributes, item_count: c.items.reduce((a, i) => a + i.quantity, 0), items: c.items })
function readBody(req) {
  return new Promise((r) => {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', () => r(b))
  })
}

const server = createServer({ cert: readFileSync(process.env.MOCK_TLS_CERT), key: readFileSync(process.env.MOCK_TLS_KEY) }, (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'POST' && req.url === '/auth/access_token') {
    readBody(req).then((b) => {
      const j = JSON.parse(b || '{}')
      if (j.grant_type !== 'client_credentials' || !j.client_id || !j.client_secret)
        return send(401, { error: 'invalid_client', error_description: 'Client authentication failed' })
      const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
      const exp = Math.floor(Date.now() / 1000) + 3600
      const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ scopes: 'read_global_api_catalog_search', exp, limits: { mock: true } })}.mock`
      send(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 })
    })
    return
  }
  if (req.method === 'GET' && req.url === '/.well-known/ucp') {
    return send(200, { ucp: { version: V, services: { 'dev.ucp.shopping': [{ version: V, transport: 'mcp', endpoint: `${ORIGIN}/api/ucp/mcp` }] }, ...ucpMeta } })
  }
  if (req.method === 'GET' && req.url === '/cart.js') {
    return send(200, sfJson(sfCartFromCookie(req, res)))
  }
  if (req.method === 'POST' && (req.url === '/cart/add.js' || req.url === '/cart/update.js')) {
    const c = sfCartFromCookie(req, res)
    readBody(req).then((b) => {
      const j = JSON.parse(b || '{}')
      if (req.url === '/cart/add.js') for (const it of j.items ?? []) c.items.push({ id: it.id, quantity: it.quantity })
      if (j.attributes) Object.assign(c.attributes, j.attributes)
      send(200, sfJson(c))
    })
    return
  }
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/products/'))) {
    sfCartFromCookie(req, res)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    // Mock of the affiliate theme script (mock only): on ?sca_ref, write a click id into the current cart.
    return res.end(`<!doctype html><title>mock store</title><h1>${req.url}</h1><script>
      if (new URLSearchParams(location.search).get('sca_ref')) setTimeout(() => fetch('/cart/update.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attributes: { _up_click_id: 'mockclick-' + Date.now() } }) }), 700)
    </script>`)
  }
  if (req.method === 'GET' && (req.url.startsWith('/checkouts/') || req.url.startsWith('/cart/'))) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' })
    return res.end('<h1>Mock merchant checkout</h1><p>Do not press Pay.</p>')
  }
  if (req.method === 'POST' && req.url === '/api/ucp/mcp') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const rpc = JSON.parse(raw)
      if (!req.headers['mcp-protocol-version'])
        return send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32600, message: 'MCP-Protocol-Version header missing' } })
      const bearer = /^Bearer \S+/.test(req.headers.authorization ?? '')
      const name = rpc.params?.name ?? ''
      console.log(`[mock] ${rpc.method}${name ? ` ${name}` : ''} auth=${bearer ? 'bearer' : 'none'}${req.headers['shopify-buyer-ip'] ? ' buyer-ip=yes' : ''}`)
      // Catalog instance (other port): Global Catalog needs the token, tools/list included.
      if (PORT !== SELLER_PORT && !bearer)
        return send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'AuthenticationRequired: Global Catalog needs a Bearer token' } })
      // Extension negotiation (seen live): a profile without the fulfillment /
      // discount capabilities gets checkout schemas without those fields.
      const profile = String(rpc.params?.arguments?.meta?.['ucp-agent']?.profile ?? '')
      if (rpc.method === 'tools/list') return send(200, { jsonrpc: '2.0', id: rpc.id, result: { tools: /cart-and-checkout/.test(profile) ? toolsWithoutExtensions() : tools } })
      if (name.endsWith('_checkout') && !bearer)
        return send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'AuthenticationRequired: checkout tools need a Bearer token' } })
      // Live behaviour (2026-10-02): token-authenticated checkout without the
      // buyer's IP → HTTP 422, -32000 AuthenticationFailed, data "Missing required buyer IP header."
      if (name.endsWith('_checkout') && !/^[0-9a-f.:]+$/i.test(String(req.headers['shopify-buyer-ip'] ?? '')))
        return send(422, { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'AuthenticationFailed', data: 'Missing required buyer IP header.' } })
      if (name.endsWith('_checkout') && process.env.MOCK_REJECT_TOKEN === '1')
        return send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'AuthenticationFailed' } })
      if (name.endsWith('_cart') && bearer)
        return send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'mock: cart tools take no token (client sent one)' } })
      if (rpc.method !== 'tools/call') return send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } })
      if (!rpc.params?.arguments?.meta?.['ucp-agent']?.profile)
        return send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32001, message: 'UCP discovery failed', data: { code: 'profile_missing' } } })
      const out = call(rpc.params.name, rpc.params.arguments)
      if (out === null) return send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `Unknown tool ${rpc.params.name}` } })
      return send(200, { jsonrpc: '2.0', id: rpc.id, result: { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] } })
    })
    return
  }
  send(404, { error: 'not found' })
})
server.listen(PORT, () => console.log(`mock UCP business on ${ORIGIN}`))
