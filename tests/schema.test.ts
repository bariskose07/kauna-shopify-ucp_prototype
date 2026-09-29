import { describe, expect, it } from 'vitest'

import { findUnknownFields, pathStatus, validate } from '../lib/ucp/schema'
import { updateCheckoutSchema } from './fixtures'

describe('live-schema checks', () => {
  const schema = updateCheckoutSchema()

  it('follows $ref + allOf to find nested fields', () => {
    expect(pathStatus(schema, 'checkout.fulfillment.methods[].destinations[].phone_number')).toBe('present')
    expect(pathStatus(schema, 'checkout.buyer.phone_number')).toBe('absent')
    expect(pathStatus(schema, 'checkout.discounts.codes')).toBe('present')
  })

  it('flags a field name the business does not list (the phone_number incident)', () => {
    const s = updateCheckoutSchema({ phoneOn: 'buyer' })
    const payload = {
      id: 'x',
      checkout: {
        fulfillment: { methods: [{ type: 'shipping', destinations: [{ street_address: '1', phone_number: '+1' }] }] },
      },
    }
    const unknown = findUnknownFields(s, payload)
    expect(unknown.map((u) => u.pointer)).toEqual(['/checkout/fulfillment/methods/0/destinations/0/phone_number'])
    expect(unknown[0].allowed).toContain('street_address')
  })

  it('allows meta and reverse-DNS extension keys', () => {
    const payload = { id: 'x', meta: { 'ucp-agent': {} }, checkout: { 'dev.ucp.buyer_ip': '1.2.3.4' } }
    expect(findUnknownFields(schema, payload)).toEqual([])
  })

  it('treats open maps (attribution) as opaque', () => {
    expect(findUnknownFields(schema, { id: 'x', checkout: { attribution: { anything: 'ok' } } })).toEqual([])
  })

  it('validate() compiles with Ajv 2020 and reports type errors', () => {
    const r = validate(schema, { id: 'x', checkout: { line_items: [{ item: { id: 'v' }, quantity: 0 }] } })
    expect(r.compiled).toBe(true)
    expect(r.valid).toBe(false)
  })
})

describe('meta.idempotency-key', () => {
  it('is absent when meta is a closed object without it (seen live on AAB search_catalog)', () => {
    const s = { type: 'object', properties: { meta: { type: 'object', properties: { 'ucp-agent': { type: 'object' } } }, catalog: { type: 'object' } } }
    expect(pathStatus(s, 'meta.idempotency-key')).toBe('absent')
    expect(findUnknownFields(s, { meta: { 'ucp-agent': {}, 'idempotency-key': 'x' } }).map((u) => u.pointer)).toEqual(['/meta/idempotency-key'])
  })
  it('meta not described at all → client still sends it (protocol-owned, like ucp-cli)', () => {
    expect(pathStatus({ type: 'object', properties: { catalog: { type: 'object' } } }, 'meta')).toBe('absent')
  })
})
