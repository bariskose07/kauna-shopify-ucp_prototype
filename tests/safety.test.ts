import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { maskPII } from '../lib/mask'
import { callTool } from '../lib/ucp/client'
import { UcpError, parseRetryAfter } from '../lib/ucp/errors'

describe('rule 1: complete_checkout is never called', () => {
  it('callTool refuses it before any network activity', async () => {
    await expect(callTool('https://us.aabcollection.com', 'complete_checkout', { id: 'x' })).rejects.toMatchObject({
      kind: 'forbidden',
    })
  })

  it('no source file calls it (only the deny-list mentions the name)', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(f) && readFileSync(p, 'utf8').includes("'complete_checkout'")) hits.push(p)
      }
    }
    for (const d of ['lib', 'app', 'components']) walk(join(__dirname, '..', d))
    expect(hits.map((h) => h.replace(/.*\/(lib|app|components)\//, '$1/'))).toEqual(['lib/ucp/client.ts'])
  })
})

describe('errors', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3)
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThanOrEqual(9)
    expect(parseRetryAfter(null)).toBeUndefined()
  })
  it('UcpError serialises without the stack', () => {
    expect(new UcpError({ kind: 'jsonrpc', rpcCode: -32001, message: 'x' }).toJSON()).toMatchObject({ kind: 'jsonrpc', rpcCode: -32001 })
  })
})

describe('maskPII', () => {
  it('masks buyer identity and address, keeps commerce fields', () => {
    const m = maskPII({
      checkout: {
        buyer: { email: 'test@example.com', first_name: 'Jane', phone_number: '+12125550123' },
        fulfillment: { methods: [{ destinations: [{ street_address: '123 Main Street', address_region: 'NY', postal_code: '11201' }] }] },
        line_items: [{ item: { id: 'gid://shopify/ProductVariant/1' }, quantity: 1 }],
      },
      messages: [{ content: 'We emailed test@example.com' }],
    })
    const s = JSON.stringify(m)
    expect(s).not.toContain('test@example.com')
    expect(s).not.toContain('Jane')
    expect(s).not.toContain('2125550123')
    expect(s).not.toContain('Main Street')
    expect(s).not.toContain('11201')
    expect(s).toContain('gid://shopify/ProductVariant/1')
    expect(s).toContain('NY')
  })
})

describe('429 circuit breaker', () => {
  it('stops calling an endpoint until Retry-After has passed', async () => {
    const { rpc, rateLimitRemaining } = await import('../lib/ucp/client')
    const ep = 'https://ratelimited.example/api/ucp/mcp'
    let calls = 0
    const orig = globalThis.fetch
    globalThis.fetch = (async () => {
      calls++
      return new Response('{}', { status: 429, headers: { 'Retry-After': '3588' } })
    }) as typeof fetch
    try {
      await expect(rpc(ep, 'tools/list', {})).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 3588 })
      await expect(rpc(ep, 'tools/list', {})).rejects.toMatchObject({ kind: 'rate_limited' })
      expect(calls).toBe(1) // second call never hit the network
      expect(rateLimitRemaining(ep)).toBeGreaterThan(3500)
    } finally {
      globalThis.fetch = orig
    }
  })
})

describe('lookup id parsing', () => {
  it('recognises variant GIDs, numbers, UPIDs and product URLs', async () => {
    const { parseLookupId } = await import('../lib/ucp/catalog')
    expect(parseLookupId('54030028341562')).toMatchObject({ kind: 'variant', raw: 'gid://shopify/ProductVariant/54030028341562' })
    expect(parseLookupId('gid://shopify/p/abc')).toMatchObject({ kind: 'upid' })
    expect(parseLookupId('https://us.aabcollection.com/products/green-tartan-maxi?variant=1&utm=x')).toMatchObject({
      kind: 'url',
      origin: 'https://us.aabcollection.com',
      handle: 'green-tartan-maxi',
      numeric: '1',
    })
    expect(parseLookupId('us.aabcollection.com/products/x')).toMatchObject({ kind: 'url', handle: 'x' })
  })
})

describe('auth attribution', () => {
  it('rate-limit from JSON-RPC error.data.retry_after blocks the endpoint', async () => {
    const { rpc, rateLimitRemaining } = await import('../lib/ucp/client')
    const ep = 'https://rpc-ratelimit.example/api/ucp/mcp'
    const orig = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Too many', data: { retry_after: 120 } } }), {
        status: 200,
      })) as typeof fetch
    try {
      await expect(rpc(ep, 'tools/list', {})).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 120 })
      expect(rateLimitRemaining(ep)).toBeGreaterThan(100)
    } finally {
      globalThis.fetch = orig
    }
  })
})
