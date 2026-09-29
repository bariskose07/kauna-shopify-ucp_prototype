import { describe, expect, it } from 'vitest'

import type { CheckoutDraft } from '../lib/session'
import { buildCheckoutBody, schemaFacts, withUtm } from '../lib/ucp/checkout'
import { validate } from '../lib/ucp/schema'
import { DEFAULT_BUYER, type CommerceObject } from '../lib/ucp/types'
import { lastCheckout, updateCheckoutSchema } from './fixtures'

function draft(over: Partial<CheckoutDraft> = {}): CheckoutDraft {
  return {
    seller: 'https://us.aabcollection.com',
    draftOrderId: 'KAUNA-TEST-1',
    buyer: DEFAULT_BUYER,
    includePhone: true,
    phonePlacement: 'none',
    discountCodes: [],
    selectedOptions: {},
    injectWrongField: false,
    ...over,
  }
}

describe('schemaFacts', () => {
  it('puts the phone on the delivery destination when the schema has it there', () => {
    expect(schemaFacts(updateCheckoutSchema({ phoneOn: 'destination' }), 'update').phonePlacement).toBe(
      'fulfillment.methods[].destinations[].phone_number',
    )
  })
  it('falls back to buyer.phone_number', () => {
    expect(schemaFacts(updateCheckoutSchema({ phoneOn: 'buyer' }), 'update').phonePlacement).toBe('buyer.phone_number')
  })
  it('reports none when no phone field exists', () => {
    expect(schemaFacts(updateCheckoutSchema({ phoneOn: 'none' }), 'update').phonePlacement).toBe('none')
  })
})

describe('buildCheckoutBody (PUT semantics)', () => {
  const schema = updateCheckoutSchema()
  const facts = schemaFacts(schema, 'update')
  const last = lastCheckout as unknown as CommerceObject

  it('always resends line items, buyer, destination, groups, discounts, attribution', () => {
    const { body } = buildCheckoutBody({ draft: draft({ discountCodes: ['KAUNA10'] }), facts, last, includeFulfillment: true })
    expect(body.line_items).toEqual([{ id: 'li_1', item: { id: 'gid://shopify/ProductVariant/54030028341562' }, quantity: 1 }])
    expect(body.buyer).toEqual({ email: 'test@example.com', first_name: 'Jane', last_name: 'Smith' })
    const method = (body.fulfillment as { methods: Record<string, unknown>[] }).methods[0]
    expect(method.id).toBe('m_1')
    expect(method.line_item_ids).toEqual(['li_1'])
    expect(method.groups).toEqual([{ id: 'g_1', selected_option_id: 'std' }])
    expect((method.destinations as Record<string, string>[])[0].phone_number).toBe('+12125550123')
    expect(body.discounts).toEqual({ codes: ['KAUNA10'] })
    expect(body.attribution).toMatchObject({
      referring_domain: 'kauna.ai',
      utm_source: 'kauna',
      utm_medium: 'agentic_commerce',
      utm_campaign: 'in_app_checkout',
      event_id: 'KAUNA-TEST-1',
    })
    // And the whole thing passes the live-schema pre-flight.
    const v = validate(schema, { id: 'x', checkout: body })
    expect(v.unknownFields).toEqual([])
    expect(v.valid).toBe(true)
  })

  it('omits the phone when includePhone is false (scenario 1)', () => {
    const { body } = buildCheckoutBody({ draft: draft({ includePhone: false }), facts, last, includeFulfillment: true })
    const dest = (body.fulfillment as { methods: { destinations: Record<string, string>[] }[] }).methods[0].destinations[0]
    expect(dest.phone_number).toBeUndefined()
  })

  it('uses the buyer’s shipping option choice', () => {
    const { body } = buildCheckoutBody({ draft: draft({ selectedOptions: { g_1: 'exp' } }), facts, last, includeFulfillment: true })
    const method = (body.fulfillment as { methods: Record<string, unknown>[] }).methods[0]
    expect(method.groups).toEqual([{ id: 'g_1', selected_option_id: 'exp' }])
  })

  it('scenario 5 injects a key the schema rejects', () => {
    const out = buildCheckoutBody({ draft: draft({ injectWrongField: true }), facts, last, includeFulfillment: true })
    expect(out.faultInjected).toBe(true)
    const v = validate(schema, { id: 'x', checkout: out.body })
    expect(v.unknownFields.map((u) => u.pointer)).toContain('/checkout/fulfillment/methods/0/destinations/0/address1')
  })

  it('create from cart uses cart_id + empty line_items when supported', () => {
    const s = updateCheckoutSchema() as Record<string, any>
    s.$defs.checkout.allOf[0].properties.cart_id = { type: 'string' }
    const f = schemaFacts(s, 'create')
    const { body } = buildCheckoutBody({
      draft: draft(),
      facts: f,
      cart: { seller: 'x', cartId: 'cart_1', cartSupported: true, lineItems: [{ item: { id: 'v' }, quantity: 1 }] },
      includeFulfillment: false,
    })
    expect(body.cart_id).toBe('cart_1')
    expect(body.line_items).toEqual([])
    expect(body.fulfillment).toBeUndefined()
  })
})

describe('withUtm', () => {
  it('adds the same UTM parameters to continue_url', () => {
    const u = new URL(withUtm('https://shop.example/checkouts/cn/1?key=a', 'KAUNA-1') as string)
    expect(u.searchParams.get('utm_source')).toBe('kauna')
    expect(u.searchParams.get('utm_medium')).toBe('agentic_commerce')
    expect(u.searchParams.get('utm_campaign')).toBe('in_app_checkout')
    expect(u.searchParams.get('utm_id')).toBe('KAUNA-1')
    expect(u.searchParams.get('key')).toBe('a')
  })
})
