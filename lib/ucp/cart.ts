// Cart MCP: all add/remove iteration happens here, not on checkout — the
// Checkout MCP has tighter rate limits. One cart per seller (UCP carts and
// checkouts are merchant-scoped).

import type { CartState, ReqLineItem } from '../session'
import { callTool, getInputSchema, type CallTrace } from './client'
import { conformToSchema } from './conform'
import { isUcpError } from './errors'
import type { CommerceObject, Json } from './types'

/** Pull the cart/checkout object out of a tool payload (flat or nested). */
export function extractObject(data: Json, key: 'cart' | 'checkout'): CommerceObject {
  const nested = data[key]
  if (nested && typeof nested === 'object' && 'id' in (nested as Json)) {
    return { ucp: data.ucp, ...(nested as Json) } as CommerceObject
  }
  return data as CommerceObject
}

/** Response line items → request-shaped (id + item.id + quantity only). */
export function toRequestLines(obj: CommerceObject | undefined): ReqLineItem[] {
  return (obj?.line_items ?? []).map((li) => ({ id: li.id, item: { id: li.item.id }, quantity: li.quantity }))
}

export interface CartOpResult {
  state: CartState
  traces: CallTrace[]
  notes: string[]
}

async function pushCart(state: CartState): Promise<{ traces: CallTrace[]; notes: string[] }> {
  const traces: CallTrace[] = []
  const notes: string[] = []
  if (!state.cartSupported) return { traces, notes }
  try {
    if (!state.cartId) {
      const schema = await getInputSchema(state.seller, 'create_cart')
      const { args, dropped } = conformToSchema(schema, {
        cart: {
          line_items: state.lineItems.map((l) => ({ item: l.item, quantity: l.quantity })),
          context: { address_country: 'US' },
        },
      })
      if (dropped.length) notes.push(`Şemada olmadığı için gönderilmedi: ${dropped.map((d) => d.pointer).join(', ')}`)
      const res = await callTool<Json>(state.seller, 'create_cart', args)
      traces.push(res.trace)
      const cart = extractObject(res.data, 'cart')
      state.cartId = cart.id
      state.last = cart
      state.lineItems = toRequestLines(cart)
    } else {
      // Full replace: send every line, existing ones with their line id.
      const res = await callTool<Json>(state.seller, 'update_cart', {
        id: state.cartId,
        cart: { line_items: state.lineItems },
      })
      traces.push(res.trace)
      const cart = extractObject(res.data, 'cart')
      state.last = cart
      state.lineItems = toRequestLines(cart)
    }
  } catch (e) {
    if (isUcpError(e) && e.kind === 'not_offered') {
      // Merchant has no Cart capability → keep lines locally, checkout will
      // be created "buy-now" style with line_items.
      state.cartSupported = false
      notes.push('Mağaza Cart MCP sunmuyor; ürünler yerelde tutuluyor, checkout doğrudan line_items ile oluşturulacak.')
      return { traces, notes }
    }
    throw e
  }
  return { traces, notes }
}

export async function addLine(state: CartState, variantId: string, quantity: number): Promise<CartOpResult> {
  const existing = state.lineItems.find((l) => l.item.id === variantId)
  if (existing) existing.quantity += quantity
  else state.lineItems.push({ item: { id: variantId }, quantity })
  const { traces, notes } = await pushCart(state)
  return { state, traces, notes }
}

export async function setQuantity(state: CartState, index: number, quantity: number): Promise<CartOpResult> {
  if (quantity <= 0) state.lineItems.splice(index, 1)
  else if (state.lineItems[index]) state.lineItems[index].quantity = quantity
  if (state.lineItems.length === 0) {
    // An empty full-replace is not meaningful; start over next time.
    state.cartId = undefined
    state.last = undefined
    return { state, traces: [], notes: ['Sepet boşaldı.'] }
  }
  const { traces, notes } = await pushCart(state)
  return { state, traces, notes }
}
