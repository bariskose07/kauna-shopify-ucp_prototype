import { describe, expect, it } from 'vitest'

import { analyzeCheckout } from '../lib/ucp/analysis'
import type { CommerceObject } from '../lib/ucp/types'
import { lastCheckout } from './fixtures'

const base = lastCheckout as unknown as CommerceObject

describe('analyzeCheckout', () => {
  it('maps delivery_phone_number_required (recoverable) to the phone field', () => {
    const a = analyzeCheckout(
      {
        ...base,
        messages: [
          { type: 'error', code: 'delivery_phone_number_required', severity: 'recoverable', content: 'Phone required', path: '$.fulfillment' },
        ],
      },
      { addressSent: true },
    )
    expect(a.missingFields).toEqual([expect.objectContaining({ field: 'phone', code: 'delivery_phone_number_required' })])
    expect(a.handoff.required).toBe(false)
  })

  it('treats extension_interaction_required / requires_escalation as a hand-off', () => {
    const a = analyzeCheckout(
      {
        ...base,
        status: 'requires_escalation',
        messages: [{ type: 'error', code: 'extension_interaction_required', severity: 'requires_buyer_input', content: 'x' }],
      },
      { addressSent: true },
    )
    expect(a.handoff).toEqual({ required: true, reason: 'extension_interaction_required' })
  })

  it('never shows 0/free shipping when there is no shipping line', () => {
    const a = analyzeCheckout(
      { ...base, totals: [{ type: 'subtotal', amount: 13400 }, { type: 'total', amount: 13400 }] },
      { addressSent: false },
    )
    expect(a.shipping).toEqual({ present: false, text: 'Kargo ödeme adımında hesaplanır' })
  })

  it('reads shipping from the fulfillment total line', () => {
    const a = analyzeCheckout(base, { addressSent: true })
    expect(a.shipping).toMatchObject({ present: true, amount: 1490 })
    expect(a.totalsMismatch).toBe(false)
    expect(a.shippingChoices[0].options.map((o) => o.amount)).toEqual([1490, 2990])
  })

  it('raises the silent-failure warning when an address was sent but methods came back empty', () => {
    const a = analyzeCheckout({ ...base, fulfillment: { methods: [] } }, { addressSent: true })
    expect(a.silentFailures[0]).toMatch(/fulfillment\.methods boş/)
  })

  it('flags buyer fields that were sent but not echoed', () => {
    const a = analyzeCheckout({ ...base, buyer: { email: 'x@y.z' } }, { addressSent: false, buyerSent: { email: 'x@y.z', first_name: 'Jane' } })
    expect(a.silentFailures).toContain('buyer.first_name gönderildi ama yanıtta yok — alan adı yanlış olabilir.')
  })

  it('flags a phone that was sent but is still requested', () => {
    const a = analyzeCheckout(
      { ...base, messages: [{ type: 'error', code: 'delivery_phone_number_required', severity: 'recoverable' }] },
      { addressSent: true, phoneSent: true },
    )
    expect(a.silentFailures.some((s) => s.includes('Telefon gönderildi'))).toBe(true)
  })

  it('detects totals that do not add up', () => {
    const a = analyzeCheckout({ ...base, totals: [{ type: 'subtotal', amount: 100 }, { type: 'total', amount: 999 }] }, { addressSent: false })
    expect(a.totalsMismatch).toBe(true)
  })
})
