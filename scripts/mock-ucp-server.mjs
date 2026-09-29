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
//
// Usage (needs a TLS cert because the app only talks https):
//   MOCK_TLS_CERT=cert.pem MOCK_TLS_KEY=key.pem node scripts/mock-ucp-server.mjs
//   NODE_EXTRA_CA_CERTS=cert.pem npm run dev   → seller "localhost:8443"

import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.MOCK_PORT ?? 8443)
const ORIGIN = `https://localhost:${PORT}`
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
    cart_id: { type: 'string' },
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
  properties: { line_items: checkoutBody.properties.line_items, context: checkoutBody.properties.context },
}
const meta = { type: 'object' }
const tools = [
  { name: 'create_cart', inputSchema: { type: 'object', properties: { meta, cart: cartBody } } },
  { name: 'update_cart', inputSchema: { type: 'object', properties: { meta, id: { type: 'string' }, cart: cartBody } } },
  { name: 'get_cart', inputSchema: { type: 'object', properties: { meta, id: { type: 'string' } } } },
  { name: 'create_checkout', inputSchema: { type: 'object', properties: { meta, checkout: checkoutBody } } },
  { name: 'update_checkout', inputSchema: { type: 'object', properties: { meta, id: { type: 'string' }, checkout: checkoutBody } } },
  { name: 'get_checkout', inputSchema: { type: 'object', properties: { meta, id: { type: 'string' } } } },
]

const PRICE = 13400
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
    continue_url: `${ORIGIN}/checkouts/cn/${co.id.split('/').pop()}`,
  }
}

function applyCheckout(co, body) {
  if (body.cart_id && carts.has(body.cart_id)) co.line_items = carts.get(body.cart_id).line_items
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
      return { ucp: ucpMeta, ...cart, currency: 'USD', totals: [{ type: 'subtotal', amount: PRICE }, { type: 'total', amount: PRICE }] }
    }
    case 'update_cart': {
      const cart = carts.get(a.id)
      cart.line_items = lines(a.cart.line_items, cart.line_items)
      const sub = cart.line_items.reduce((x, l) => x + PRICE * l.quantity, 0)
      return { ucp: ucpMeta, ...cart, currency: 'USD', totals: [{ type: 'subtotal', amount: sub }, { type: 'total', amount: sub }] }
    }
    case 'create_checkout': {
      const co = { id: `gid://shopify/Checkout/${randomUUID().slice(0, 8)}`, line_items: [] }
      applyCheckout(co, a.checkout)
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
    default:
      return null
  }
}

const server = createServer({ cert: readFileSync(process.env.MOCK_TLS_CERT), key: readFileSync(process.env.MOCK_TLS_KEY) }, (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'GET' && req.url === '/.well-known/ucp') {
    return send(200, { ucp: { version: V, services: { 'dev.ucp.shopping': [{ version: V, transport: 'mcp', endpoint: `${ORIGIN}/api/ucp/mcp` }] }, ...ucpMeta } })
  }
  if (req.method === 'GET' && req.url.startsWith('/checkouts/')) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' })
    return res.end('<h1>Mock merchant checkout</h1><p>Do not press Pay.</p>')
  }
  if (req.method === 'POST' && req.url === '/api/ucp/mcp') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const rpc = JSON.parse(raw)
      if (rpc.method === 'tools/list') return send(200, { jsonrpc: '2.0', id: rpc.id, result: { tools } })
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
