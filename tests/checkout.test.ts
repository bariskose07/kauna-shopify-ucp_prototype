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

describe('field-name resolution from the live schema', () => {
  const s = {
    type: 'object',
    properties: {
      checkout: {
        type: 'object',
        properties: {
          line_items: { type: 'array', items: { type: 'object' } },
          buyer: { type: 'object', properties: { email_address: { type: 'string' }, first_name: { type: 'string' }, last_name: { type: 'string' } } },
          fulfillment: {
            type: 'object',
            properties: {
              methods: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    destinations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          first_name: { type: 'string' },
                          last_name: { type: 'string' },
                          phone: { type: 'string' },
                          address: {
                            type: 'object',
                            properties: { address1: {}, city: {}, province_code: {}, zip: {}, country_code: {} },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }

  it('maps canonical names onto the schema’s names (incl. nested address)', () => {
    const facts = schemaFacts(s, 'create')
    expect(facts.phonePlacement).toBe('fulfillment.methods[].destinations[].phone')
    const { body, notes } = buildCheckoutBody({
      draft: draft({ phonePlacement: facts.phonePlacement }),
      facts,
      cart: { seller: 'x', cartSupported: false, lineItems: [{ item: { id: 'v' }, quantity: 1 }] },
      includeFulfillment: true,
    })
    expect(body.buyer).toEqual({ email_address: 'test@example.com', first_name: 'Jane', last_name: 'Smith' })
    const dest = (body.fulfillment as { methods: { destinations: Record<string, unknown>[] }[] }).methods[0].destinations[0]
    expect(dest).toEqual({
      first_name: 'Jane',
      last_name: 'Smith',
      phone: '+12125550123',
      address: { address1: '123 Main Street', city: 'Brooklyn', province_code: 'NY', zip: '11201', country_code: 'US' },
    })
    expect(notes).toContain('buyer.email → buyer.email_address (şemadaki ad)')
    expect(validate(s, { checkout: body }).unknownFields).toEqual([])
  })

  it('adds attributionExtra (mobile attempt id) to attribution', () => {
    const facts = schemaFacts(updateCheckoutSchema(), 'update')
    const { body } = buildCheckoutBody({
      draft: draft({ attributionExtra: { utm_content: 'KAUNA-ATT-1' } }),
      facts,
      last: lastCheckout as unknown as CommerceObject,
      includeFulfillment: true,
    })
    expect(body.attribution).toMatchObject({ utm_content: 'KAUNA-ATT-1', utm_source: 'kauna' })
  })
})

describe('cart → checkout (Shopify flow)', () => {
  const cart = {
    seller: 'https://us.aabcollection.com',
    cartId: 'gid://shopify/Cart/abc',
    cartSupported: true,
    lineItems: [{ id: 'li_1', item: { id: 'gid://shopify/ProductVariant/47830495854906' }, quantity: 1 }],
  }
  const createSchema = (topLevel: boolean) => ({
    type: 'object',
    properties: {
      meta: { type: 'object' },
      ...(topLevel ? { cart_id: { type: 'string' } } : {}),
      checkout: {
        type: 'object',
        properties: {
          ...(topLevel ? {} : { cart_id: { type: 'string' } }),
          currency: { type: 'string' },
          line_items: { type: 'array', items: { type: 'object', properties: { quantity: { type: 'integer' }, item: { type: 'object', properties: { id: { type: 'string' } } } } } },
          buyer: { type: 'object', properties: { email: { type: 'string' } } },
        },
      },
    },
  })

  it('top-level cart_id when the schema has it there', () => {
    const f = schemaFacts(createSchema(true), 'create')
    expect(f.cartIdPlacement).toBe('top-level')
    const out = buildCheckoutBody({ draft: draft(), facts: f, cart, includeFulfillment: false })
    expect(out.topLevel).toEqual({ cart_id: 'gid://shopify/Cart/abc' })
    expect(out.body.cart_id).toBeUndefined()
    expect(out.body.line_items).toEqual([{ quantity: 1, item: { id: 'gid://shopify/ProductVariant/47830495854906' } }])
    expect(validate(createSchema(true), { ...out.topLevel, checkout: out.body }).unknownFields).toEqual([])
  })

  it('checkout.cart_id when nested; line items otherwise', () => {
    expect(schemaFacts(createSchema(false), 'create').cartIdPlacement).toBe('checkout')
    const none = schemaFacts({ type: 'object', properties: { checkout: { type: 'object', properties: { line_items: { type: 'array' } } } } }, 'create')
    const out = buildCheckoutBody({ draft: draft(), facts: none, cart, includeFulfillment: false })
    expect(none.cartIdPlacement).toBe('none')
    expect(out.topLevel).toEqual({})
    expect(out.notes.join(' ')).toMatch(/cart_id içermiyor/)
  })

  it('PUT body: currency + {quantity, item:{id}} lines from get_checkout (no line id unless listed)', () => {
    const f = schemaFacts(createSchema(true), 'update')
    const last = { id: 'co', currency: 'USD', line_items: [{ id: 'li_9', item: { id: 'v1' }, quantity: 2 }] } as unknown as CommerceObject
    const out = buildCheckoutBody({ draft: draft(), facts: f, last, includeFulfillment: false })
    expect(out.body.currency).toBe('USD')
    expect(out.body.line_items).toEqual([{ quantity: 2, item: { id: 'v1' } }])
    expect((out.body.buyer as Record<string, string>).email).toBe(DEFAULT_BUYER.email)
  })
})
