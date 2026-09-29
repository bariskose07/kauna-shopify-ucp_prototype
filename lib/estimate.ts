// Shipping estimate for the product page, without any buyer action.
//
// Order of attempts (cheapest first):
//   1. Cart MCP: a throw-away cart with the buyer's destination, if the live
//      create_cart / update_cart schema accepts `fulfillment` (cart estimates).
//   2. Checkout MCP: a throw-away checkout (create + full update with the
//      destination) — the authoritative option map. Checkout rate limits are
//      tighter, so this only runs when the cart gives nothing.
// Nothing here touches the user's real cart/checkout state; the temporary
// cart/checkout ids are not stored. complete_checkout is still never called.

import { logged } from './api'
import { newDraftOrderId, type CheckoutDraft, type Session } from './session'
import { analyzeCheckout, type ShippingChoice } from './ucp/analysis'
import { extractObject, toRequestLines } from './ucp/cart'
import { buildCheckoutBody, schemaFacts } from './ucp/checkout'
import { callTool, getInputSchema } from './ucp/client'
import { pathStatus } from './ucp/schema'
import type { BuyerInfo, CommerceObject, Json } from './ucp/types'

export interface ShippingEstimate {
  source: 'cart' | 'checkout' | 'none'
  currency?: string
  /** Shipping total line (minor units) when the business priced it. */
  amount?: number
  label?: string
  choices: ShippingChoice[]
  destination: string
  messages: { code?: string; content?: string; severity?: string }[]
  notes: string[]
}

function destinationOf(b: BuyerInfo) {
  return {
    first_name: b.first_name,
    last_name: b.last_name,
    street_address: b.street_address,
    address_locality: b.address_locality,
    address_region: b.address_region,
    postal_code: b.postal_code,
    address_country: b.address_country,
  }
}

function summarize(co: CommerceObject, source: ShippingEstimate['source'], destination: string, notes: string[]): ShippingEstimate {
  const a = analyzeCheckout(co, { addressSent: true })
  const line = a.totals.find((t) => ['fulfillment', 'shipping', 'delivery'].includes(t.type))
  return {
    source,
    currency: co.currency,
    amount: line?.amount,
    label: line?.display_text,
    choices: a.shippingChoices,
    destination,
    messages: (co.messages ?? []).map((m) => ({ code: m.code, content: m.content, severity: m.severity })),
    notes,
  }
}

const hasPrice = (e: ShippingEstimate) =>
  e.amount !== undefined || e.choices.some((c) => c.options.some((o) => o.amount !== undefined))

/** Keep only destination keys the schema lists at `path` (rule 4). */
function destFor(schema: Json, path: string, b: BuyerInfo, notes: string[]): Json {
  const d = destinationOf(b) as Record<string, string>
  const out: Json = {}
  for (const [k, v] of Object.entries(d)) {
    const st = pathStatus(schema, `${path}.${k}`)
    if (st === 'absent') notes.push(`${k} şemada yok → gönderilmedi`)
    else out[k] = v
  }
  return out
}

export async function estimateShipping(s: Session, seller: string, variantId: string, buyer: BuyerInfo): Promise<ShippingEstimate> {
  const where = `${buyer.address_locality}, ${buyer.address_region} ${buyer.postal_code}`
  const notes: string[] = []

  // ── 1. cart estimate ────────────────────────────────────────────────────
  try {
    const createSchema = (await getInputSchema(seller, 'create_cart')) as Json
    const destPath = 'cart.fulfillment.methods[].destinations[]'
    const lines = [{ item: { id: variantId }, quantity: 1 }]
    if (pathStatus(createSchema, destPath) === 'present') {
      const r = await logged(s, seller, () =>
        callTool<Json>(seller, 'create_cart', {
          cart: {
            line_items: lines,
            fulfillment: { methods: [{ type: 'shipping', destinations: [destFor(createSchema, destPath, buyer, notes)] }] },
          },
        }),
      )
      const est = summarize(extractObject(r.data, 'cart'), 'cart', where, notes)
      if (hasPrice(est)) return est
      notes.push('Sepet (create_cart) kargo tahmini döndürmedi.')
    } else {
      const updateSchema = (await getInputSchema(seller, 'update_cart').catch(() => ({}))) as Json
      if (pathStatus(updateSchema, destPath) === 'present') {
        const c = await logged(s, seller, () => callTool<Json>(seller, 'create_cart', { cart: { line_items: lines } }))
        const cart = extractObject(c.data, 'cart')
        const method: Json = { type: 'shipping', destinations: [destFor(updateSchema, destPath, buyer, notes)] }
        if (pathStatus(updateSchema, 'cart.fulfillment.methods[].line_item_ids') === 'present')
          method.line_item_ids = (cart.line_items ?? []).map((l) => l.id)
        const u = await logged(s, seller, () =>
          callTool<Json>(seller, 'update_cart', { id: cart.id, cart: { line_items: toRequestLines(cart), fulfillment: { methods: [method] } } }),
        )
        const est = summarize(extractObject(u.data, 'cart'), 'cart', where, notes)
        if (hasPrice(est)) return est
        notes.push('Sepet (update_cart) kargo tahmini döndürmedi.')
      } else {
        notes.push('Mağazanın sepet şeması teslimat adresi kabul etmiyor.')
      }
    }
  } catch (e) {
    notes.push(`Sepet tahmini başarısız: ${(e as Error).message}`)
  }

  // ── 2. checkout (authoritative) ─────────────────────────────────────────
  try {
    const [cs, us] = await Promise.all([getInputSchema(seller, 'create_checkout'), getInputSchema(seller, 'update_checkout')])
    const cf = schemaFacts(cs, 'create')
    const uf = schemaFacts(us, 'update')
    const draft: CheckoutDraft = {
      seller,
      draftOrderId: newDraftOrderId(),
      buyer,
      includePhone: true,
      phonePlacement: uf.phonePlacement,
      discountCodes: [],
      selectedOptions: {},
      injectWrongField: false,
    }
    const tmpCart = { seller, cartSupported: false, lineItems: [{ item: { id: variantId }, quantity: 1 }] }
    const c1 = buildCheckoutBody({ draft, facts: cf, cart: tmpCart, includeFulfillment: false })
    const r1 = await logged(s, seller, () => callTool<Json>(seller, 'create_checkout', { checkout: c1.body }))
    const co = extractObject(r1.data, 'checkout')
    const u = buildCheckoutBody({ draft, facts: uf, last: co, includeFulfillment: true })
    const r2 = await logged(s, seller, () => callTool<Json>(seller, 'update_checkout', { id: co.id, checkout: u.body }))
    notes.push('Kargo, geçici bir checkout ile hesaplandı (sepet tahmini yoktu).')
    return summarize(extractObject(r2.data, 'checkout'), 'checkout', where, notes)
  } catch (e) {
    notes.push(`Checkout ile tahmin başarısız: ${(e as Error).message}`)
  }
  return { source: 'none', choices: [], destination: where, messages: [], notes }
}
