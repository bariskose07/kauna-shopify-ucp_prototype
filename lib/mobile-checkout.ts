// Mobile harness: one-shot UCP checkout for a single variant (buy-now).
// Stateless — no session, nothing stored. The cart token/key are returned
// only in this response (the phone needs them for Mode C) and never logged.
//
// Differences from the web flow (which stays unchanged):
//   - The shipping destination is sent in create_checkout when the live
//     create schema accepts it without line_item_ids → one request instead of
//     two (Checkout MCP limits are tight). If the business still reports
//     missing address/contact, one full update_checkout follows.
//   - attribution.utm_content = Kauna attempt id (matches the phone's log).

import { randomUUID } from 'node:crypto'

import { newDraftOrderId, normalizeSeller, type CheckoutDraft } from './session'
import { analyzeCheckout } from './ucp/analysis'
import { extractObject } from './ucp/cart'
import { buildCheckoutBody, schemaFacts, withUtm } from './ucp/checkout'
import { callTool, getInputSchema, type AuthInfo } from './ucp/client'
import { UcpError } from './ucp/errors'
import type { BuyerInfo, CommerceObject, Json } from './ucp/types'

export interface MobileCheckoutInput {
  seller: string
  /** Numeric id or gid://shopify/ProductVariant/{id}. */
  variantId: string
  quantity?: number
  buyer: BuyerInfo
  includePhone?: boolean
  /** Kauna attempt id from the phone's test log. */
  attemptId?: string
}

/** Codes that mean "the buyer / address we sent was not applied". */
const BUYER_CODES = /buyer_identity|contact_method|email|delivery_address|shipping_address|address_required|phone/i

export function toVariantGid(id: string): string {
  const t = id.trim()
  if (/^\d+$/.test(t)) return `gid://shopify/ProductVariant/${t}`
  return t
}

/**
 * `gid://shopify/Checkout/{TOKEN}?key={KEY}` → cart token + key.
 * (The long `key` inside continue_url is something else — not used here.)
 */
export function parseCheckoutId(id: string): { cartToken?: string; cartKey?: string } {
  const m = /^gid:\/\/shopify\/Checkout\/([^?]+)(?:\?key=([^&]+))?/.exec(id)
  if (!m) return {}
  return { cartToken: m[1], cartKey: m[2] }
}

export function maskSecret(v: string | undefined): string | undefined {
  if (!v) return v
  return v.length <= 6 ? '******' : `${v.slice(0, 6)}…`
}

export async function mobileUcpCheckout(input: MobileCheckoutInput) {
  const seller = normalizeSeller(input.seller)
  const attemptId = input.attemptId?.trim() || `KAUNA-ATT-${randomUUID().slice(0, 8).toUpperCase()}`
  const [cs, us] = await Promise.all([getInputSchema(seller, 'create_checkout'), getInputSchema(seller, 'update_checkout')])
  const cf = schemaFacts(cs, 'create')
  const uf = schemaFacts(us, 'update')

  const draft: CheckoutDraft = {
    seller,
    draftOrderId: attemptId || newDraftOrderId(),
    buyer: input.buyer,
    includePhone: input.includePhone ?? true,
    phonePlacement: cf.phonePlacement !== 'none' ? cf.phonePlacement : uf.phonePlacement,
    discountCodes: [],
    selectedOptions: {},
    injectWrongField: false,
    attributionExtra: { utm_content: attemptId },
  }
  const cart = {
    seller,
    cartSupported: false,
    lineItems: [{ item: { id: toVariantGid(input.variantId) }, quantity: Math.max(1, input.quantity ?? 1) }],
  }

  const auth: { step: string; auth?: AuthInfo }[] = []
  const timings: Record<string, number> = {}

  // 1. create — with the destination when the schema allows it without line ids.
  const destInCreate = cf.supportsFulfillment && !cf.methodRequired.includes('line_item_ids')
  const c1 = buildCheckoutBody({ draft: { ...draft, phonePlacement: cf.phonePlacement }, facts: cf, cart, includeFulfillment: destInCreate })
  let t = Date.now()
  const r1 = await callTool<Json>(seller, 'create_checkout', { checkout: c1.body })
  timings.createMs = Date.now() - t
  auth.push({ step: 'create_checkout', auth: r1.trace.auth })
  let co: CommerceObject = extractObject(r1.data, 'checkout')
  const notes = [...c1.notes]
  if (destInCreate) notes.push('Teslimat adresi create_checkout içinde gönderildi (tek istek).')

  // 2. one full update only if the address/contact did not land.
  const missing = (co.messages ?? []).filter((m) => m.type === 'error' && BUYER_CODES.test(m.code ?? ''))
  const noDest = !(co.fulfillment?.methods ?? []).some((m) => (m.destinations ?? []).length > 0)
  if (uf.supportsFulfillment && (noDest || missing.length > 0)) {
    const u = buildCheckoutBody({ draft: { ...draft, phonePlacement: uf.phonePlacement }, facts: uf, last: co, includeFulfillment: true })
    notes.push(...u.notes.filter((n) => !notes.includes(n)))
    t = Date.now()
    const r2 = await callTool<Json>(seller, 'update_checkout', { id: co.id, checkout: u.body })
    timings.updateMs = Date.now() - t
    auth.push({ step: 'update_checkout', auth: r2.trace.auth })
    co = extractObject(r2.data, 'checkout')
    notes.push('Adres/iletişim eksik görünüyordu → tam update_checkout gönderildi.')
  }

  const a = analyzeCheckout(co, { addressSent: true })
  const { cartToken, cartKey } = parseCheckoutId(co.id)
  if (!cartToken || !cartKey) {
    notes.push('Checkout id beklenen biçimde değil (gid://shopify/Checkout/{TOKEN}?key={KEY}); Mod C kullanılamaz.')
  } else if (cartKey.length !== 32) {
    notes.push(`Sepet anahtarı ${cartKey.length} karakter (beklenen 32) — Mod C'de doğrulayın.`)
  }
  const buyerWarnings = (co.messages ?? [])
    .filter((m) => BUYER_CODES.test(m.code ?? ''))
    .map((m) => ({ code: m.code, severity: m.severity, content: m.content }))

  return {
    attemptId,
    seller,
    status: a.status,
    currency: co.currency,
    totals: a.totals,
    shipping: a.shipping,
    shippingChoices: a.shippingChoices.map((g) => ({
      groupId: g.groupId,
      selectedOptionId: g.selectedOptionId,
      options: g.options.map((o) => ({ id: o.id, title: o.title, amount: o.amount, estimate: o.estimate })),
    })),
    messages: (co.messages ?? []).map((m) => ({ type: m.type, code: m.code, severity: m.severity, content: m.content })),
    buyerWarnings,
    handoff: a.handoff,
    lineItems: (co.line_items ?? []).map((l) => ({ title: l.item.title, quantity: l.quantity, image: l.item.image_url })),
    continueUrl: withUtm(co.continue_url, attemptId),
    rawContinueUrl: co.continue_url,
    checkoutIdMasked: `${co.id.split('?')[0].slice(0, 30)}…`,
    // Sensitive: only in this response, never logged or stored server-side.
    cartToken,
    cartKey,
    auth,
    phonePlacement: draft.phonePlacement,
    fieldNotes: notes,
    timings,
  }
}

export function assertInput(b: Partial<MobileCheckoutInput>): asserts b is MobileCheckoutInput {
  if (!b.seller || !b.variantId || !b.buyer) {
    throw new UcpError({ kind: 'schema', message: 'seller, variantId ve buyer gerekli' })
  }
}
