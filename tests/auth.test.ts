// Shopify "Authenticate your agent" pattern: who gets the Bearer token,
// what happens when it is missing or rejected, headers and profiles.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CART_CHECKOUT_PROFILE,
  CATALOG_PROFILE,
  MCP_PROTOCOL_VERSION,
  callTool,
  decodeJwt,
  declaresCartAndCheckout,
  getAccessToken,
  getTokenState,
  isPublicIp,
  maskIp,
  rpc,
  setAuthSettings,
  surfaceOf,
  tokenRequired,
  type RpcInfo,
} from '../lib/ucp/client'

const CATALOG = 'https://catalog.example/api/ucp/mcp'
const MERCHANT = 'https://shop.example'
const MERCHANT_MCP = `${MERCHANT}/api/ucp/mcp`

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.sig`

type Seen = { url: string; headers: Record<string, string>; body?: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } }

const g = globalThis as unknown as { __ucpToken?: unknown; __ucpTokenState?: { error?: unknown; rejected?: unknown }; __ucpDisc?: Map<string, unknown>; __ucpTools?: Map<string, unknown> }

function reset() {
  g.__ucpToken = undefined
  if (g.__ucpTokenState) {
    g.__ucpTokenState.error = undefined
    g.__ucpTokenState.rejected = undefined
  }
  g.__ucpDisc?.clear()
  g.__ucpTools?.clear()
  setAuthSettings({ tokenlessFallback: false, cliTransport: false })
}

const tools = [
  { name: 'create_cart', inputSchema: { type: 'object', properties: { meta: { type: 'object' }, cart: { type: 'object' } } } },
  { name: 'create_checkout', inputSchema: { type: 'object', properties: { meta: { type: 'object' }, cart_id: { type: 'string' }, checkout: { type: 'object' } } } },
  { name: 'cancel_checkout', inputSchema: { type: 'object', properties: { meta: { type: 'object' }, id: { type: 'string' } } } },
]

/**
 * Fake network: token endpoint, merchant /.well-known/ucp and MCP endpoint.
 * `rejectToken` → the merchant answers like aab-usa-v2 did live.
 */
function fakeNet(opts: { tokenOk?: boolean; rejectToken?: boolean; requireBuyerIp?: boolean; exp?: number } = {}) {
  const seen: Seen[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (url.includes('/auth/access_token')) {
      seen.push({ url, headers })
      if (opts.tokenOk === false)
        return new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Client authentication failed' }), { status: 401 })
      const exp = opts.exp ?? Math.floor(Date.now() / 1000) + 3600
      return new Response(
        JSON.stringify({ access_token: jwt({ scopes: 'read_global_api_catalog_search', exp, limits: { rpm: 60 } }), expires_in: 3600 }),
        { status: 200 },
      )
    }
    if (url.endsWith('/.well-known/ucp')) {
      return new Response(
        JSON.stringify({ ucp: { version: '2026-04-08', services: { 'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'mcp', endpoint: MERCHANT_MCP }] } } }),
        { status: 200 },
      )
    }
    const body = JSON.parse(String(init?.body)) as Seen['body'] & { id: number }
    seen.push({ url, headers, body })
    if (body.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools } }), { status: 200 })
    if (opts.requireBuyerIp && body.params?.name?.endsWith('_checkout') && !headers['Shopify-Buyer-IP'])
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'AuthenticationFailed', data: 'Missing required buyer IP header.' } }),
        { status: 422 },
      )
    if (opts.rejectToken && headers.Authorization)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'AuthenticationFailed' } }), { status: 200 })
    const out = { id: 'gid://shopify/Checkout/abc?key=k', status: 'incomplete', line_items: [] }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } }), {
      status: 200,
    })
  }) as typeof fetch
  return { seen, restore: () => (globalThis.fetch = orig) }
}

beforeEach(() => {
  process.env.SHOPIFY_CLIENT_ID = 'id'
  process.env.SHOPIFY_CLIENT_SECRET = 'secret'
  process.env.SHOPIFY_CATALOG_URL = CATALOG
  reset()
})
afterEach(() => {
  delete process.env.SHOPIFY_CLIENT_ID
  delete process.env.SHOPIFY_CLIENT_SECRET
  delete process.env.SHOPIFY_CATALOG_URL
  delete process.env.SHOPIFY_API_KEY
  delete process.env.SHOPIFY_API_SECRET
  delete process.env.UCP_BUYER_IP
  reset()
})

describe('per-call token policy', () => {
  it('Bearer on Global Catalog and checkout tools only', () => {
    expect(tokenRequired(surfaceOf(CATALOG, 'search_catalog'), 'search_catalog')).toBe(true)
    expect(tokenRequired(surfaceOf(CATALOG, 'tools/list'), 'tools/list')).toBe(true)
    for (const t of ['create_checkout', 'get_checkout', 'update_checkout', 'cancel_checkout'])
      expect(tokenRequired(surfaceOf(MERCHANT_MCP, t), t)).toBe(true)
    for (const t of ['create_cart', 'update_cart', 'get_cart', 'cancel_cart', 'search_catalog', 'get_product', 'tools/list'])
      expect(tokenRequired(surfaceOf(MERCHANT_MCP, t), t)).toBe(false)
  })

  it('cart call: no Authorization, cart+checkout profile, MCP-Protocol-Version', async () => {
    const net = fakeNet()
    try {
      const r = await callTool(MERCHANT, 'create_cart', { cart: {} })
      const call = net.seen.find((x) => x.body?.params?.name === 'create_cart')!
      expect(call.headers.Authorization).toBeUndefined()
      expect(call.headers['MCP-Protocol-Version']).toBe(MCP_PROTOCOL_VERSION)
      expect((call.body?.params?.arguments?.meta as { 'ucp-agent': { profile: string } })['ucp-agent'].profile).toBe(CART_CHECKOUT_PROFILE)
      expect(r.trace.auth).toMatchObject({ mode: 'none', label: 'token yok – tasarım gereği' })
      expect(net.seen.some((x) => x.url.includes('/auth/access_token'))).toBe(false)
    } finally {
      net.restore()
    }
  })

  it('checkout call: Bearer token, scopes recorded, content[0].text parsed', async () => {
    const net = fakeNet()
    try {
      const r = await callTool(MERCHANT, 'create_checkout', { cart_id: 'gid://shopify/Cart/1', checkout: {} })
      const call = net.seen.find((x) => x.body?.params?.name === 'create_checkout')!
      expect(call.headers.Authorization).toMatch(/^Bearer /)
      expect(call.body?.params?.arguments?.cart_id).toBe('gid://shopify/Cart/1')
      expect(r.trace.auth).toMatchObject({ mode: 'token', tokenScopes: ['read_global_api_catalog_search'] })
      expect(r.trace.payloadSource).toBe('content[0].text')
      expect(r.data.status).toBe('incomplete')
      // tools/list on the merchant endpoint is a no-token call
      expect(net.seen.find((x) => x.body?.method === 'tools/list')!.headers.Authorization).toBeUndefined()
    } finally {
      net.restore()
    }
  })

  it('Global Catalog uses the catalog profile', async () => {
    expect(CATALOG_PROFILE).toMatch(/examples\/2026-08-25\/valid-with-capabilities\.json$/)
    expect(CART_CHECKOUT_PROFILE).toMatch(/examples\/2026-08-25\/cart-and-checkout\.json$/)
  })
})

describe('no silent fallback', () => {
  it('token failure → auth error, request not sent, reason kept for the banner', async () => {
    const net = fakeNet({ tokenOk: false })
    try {
      const info: RpcInfo = {}
      await expect(rpc(CATALOG, 'tools/list', {}, 0, info)).rejects.toMatchObject({ kind: 'auth' })
      expect(net.seen.filter((x) => x.url === CATALOG)).toHaveLength(0)
      expect(getTokenState()).toMatchObject({ status: 'failed' })
      expect(getTokenState().error?.message).toMatch(/Client authentication failed/)
    } finally {
      net.restore()
    }
  })

  it('token failure with the test setting → sent without token, labelled "token yok – yedek"', async () => {
    const net = fakeNet({ tokenOk: false })
    setAuthSettings({ tokenlessFallback: true })
    try {
      const info: RpcInfo = {}
      await rpc(CATALOG, 'tools/list', {}, 0, info)
      expect(info.auth).toMatchObject({ mode: 'fallback', label: 'token yok – yedek' })
      expect(net.seen.find((x) => x.url === CATALOG)!.headers.Authorization).toBeUndefined()
    } finally {
      net.restore()
    }
  })

  it('AuthenticationFailed from the merchant → explicit error, no tokenless retry', async () => {
    const net = fakeNet({ rejectToken: true })
    try {
      await expect(callTool(MERCHANT, 'create_checkout', { checkout: {} })).rejects.toMatchObject({ kind: 'auth', rpcCode: -32000 })
      expect(net.seen.filter((x) => x.body?.params?.name === 'create_checkout')).toHaveLength(1)
      expect(getTokenState().rejected).toMatchObject({ host: 'shop.example', tool: 'create_checkout' })
    } finally {
      net.restore()
    }
  })

  it('AuthenticationFailed with the test setting → one tokenless retry, marked fallback', async () => {
    const net = fakeNet({ rejectToken: true })
    setAuthSettings({ tokenlessFallback: true })
    try {
      const r = await callTool(MERCHANT, 'cancel_checkout', { id: 'gid://shopify/Checkout/abc?key=k' })
      const calls = net.seen.filter((x) => x.body?.params?.name === 'cancel_checkout')
      expect(calls).toHaveLength(2)
      expect(calls[0].headers.Authorization).toMatch(/^Bearer /)
      expect(calls[1].headers.Authorization).toBeUndefined()
      expect(r.trace.auth).toMatchObject({ mode: 'fallback' })
      expect(r.trace.auth?.note).toMatch(/reddedildi/)
    } finally {
      net.restore()
    }
  })
})

describe('token', () => {
  it('decodes scopes / exp / limits from the JWT payload', () => {
    const c = decodeJwt(jwt({ scopes: 'read_global_api_catalog_search read_global_api_orders', exp: 2_000_000_000, limits: { a: 1 } }))
    expect(c).toEqual({ scopes: ['read_global_api_catalog_search', 'read_global_api_orders'], exp: 2_000_000_000, limits: { a: 1 } })
    expect(decodeJwt('not-a-jwt')).toEqual({ scopes: [] })
  })

  it('reuses the token until 1 minute before exp, then refreshes', async () => {
    const net = fakeNet({ exp: Math.floor(Date.now() / 1000) + 90 })
    try {
      await getAccessToken()
      await getAccessToken()
      expect(net.seen.filter((x) => x.url.includes('/auth/access_token'))).toHaveLength(1)
      ;(g.__ucpToken as { expiresAt: number }).expiresAt = Date.now() + 59_000
      await getAccessToken()
      expect(net.seen.filter((x) => x.url.includes('/auth/access_token'))).toHaveLength(2)
    } finally {
      net.restore()
    }
  })

  it('reads legacy credential names with a warning', async () => {
    delete process.env.SHOPIFY_CLIENT_ID
    delete process.env.SHOPIFY_CLIENT_SECRET
    process.env.SHOPIFY_API_KEY = 'id'
    process.env.SHOPIFY_API_SECRET = 'secret'
    expect(getTokenState()).toMatchObject({ configured: true, credentialSource: 'SHOPIFY_API_KEY/SHOPIFY_API_SECRET' })
    expect(getTokenState().warning).toMatch(/SHOPIFY_CLIENT_ID/)
  })
})

describe('agent profile override', () => {
  it('is used only when it declares cart and checkout', () => {
    expect(declaresCartAndCheckout({ ucp: { capabilities: { 'dev.ucp.shopping.cart': [], 'dev.ucp.shopping.checkout': [] } } })).toBe(true)
    expect(declaresCartAndCheckout({ ucp: { capabilities: [{ name: 'dev.ucp.shopping.cart' }, { name: 'dev.ucp.shopping.checkout' }] } })).toBe(true)
    expect(declaresCartAndCheckout({ ucp: { capabilities: { 'dev.ucp.shopping.checkout': [] } } })).toBe(false)
  })
})

describe('Shopify-Buyer-IP', () => {
  it('checkout calls carry the buyer IP; cart calls do not', async () => {
    process.env.UCP_BUYER_IP = '203.0.113.7'
    const net = fakeNet({ requireBuyerIp: true })
    try {
      const r = await callTool(MERCHANT, 'create_checkout', { checkout: {} })
      await callTool(MERCHANT, 'create_cart', { cart: {} })
      expect(net.seen.find((x) => x.body?.params?.name === 'create_checkout')!.headers['Shopify-Buyer-IP']).toBe('203.0.113.7')
      expect(net.seen.find((x) => x.body?.params?.name === 'create_cart')!.headers['Shopify-Buyer-IP']).toBeUndefined()
      expect(r.trace.auth).toMatchObject({ buyerIp: '203.0.x.x', buyerIpSource: 'UCP_BUYER_IP' })
    } finally {
      net.restore()
    }
  })

  it('missing IP is reported as such, not as a token rejection', async () => {
    const net = fakeNet({ requireBuyerIp: true })
    try {
      const err = await callTool(MERCHANT, 'create_checkout', { checkout: {} }).catch((e) => e)
      expect(err).toMatchObject({ kind: 'jsonrpc', httpStatus: 422 })
      expect(err.message).toMatch(/Shopify-Buyer-IP/)
      expect(getTokenState().rejected).toBeUndefined()
    } finally {
      net.restore()
    }
  })

  it('only public addresses count as a buyer IP', () => {
    for (const ip of ['127.0.0.1', '192.168.1.34', '10.0.0.2', '172.20.1.1', '::1', 'fe80::1', '::ffff:192.168.0.1']) expect(isPublicIp(ip)).toBe(false)
    for (const ip of ['203.0.113.7', '85.105.1.2', '2a02:aa1::1']) expect(isPublicIp(ip)).toBe(true)
    expect(maskIp('85.105.1.2')).toBe('85.105.x.x')
  })
})
