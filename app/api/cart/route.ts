import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { getSession, normalizeSeller, pushLog, type CartState } from '@/lib/session'
import { addLine, ensureLine, setQuantity } from '@/lib/ucp/cart'
import type { CallTrace } from '@/lib/ucp/client'

export const dynamic = 'force-dynamic'

function cartsView(carts: Record<string, CartState>) {
  return Object.values(carts).map((c) => ({
    seller: c.seller,
    cartId: c.cartId,
    cartSupported: c.cartSupported,
    lineItems: c.lineItems,
    last: c.last,
  }))
}

export async function GET() {
  const s = await getSession()
  return NextResponse.json({ carts: cartsView(s.carts) })
}

interface Body {
  action: 'add' | 'ensure' | 'set'
  seller: string
  variantId?: string
  quantity?: number
  index?: number
}

// All add/remove iteration goes through Cart MCP (checkout rate limits are tighter).
export async function POST(req: Request) {
  const b = (await req.json()) as Body
  if (!b.seller) return badRequest('seller gerekli')
  const s = await getSession()
  const seller = normalizeSeller(b.seller)
  const state = (s.carts[seller] ??= { seller, cartSupported: true, lineItems: [] })
  const log = (traces: CallTrace[]) => {
    for (const t of traces)
      pushLog(s, { seller, tool: t.tool, auth: t.auth, surface: t.surface, endpoint: t.endpoint, durationMs: t.durationMs, request: t.request, response: t.response, validation: t.validation })
  }
  // Snapshot so a rejected change can be rolled back exactly.
  const before = structuredClone(state.lineItems)
  try {
    const r =
      b.action === 'add' || b.action === 'ensure'
        ? b.variantId
          ? await (b.action === 'add' ? addLine : ensureLine)(state, b.variantId, Math.max(1, b.quantity ?? 1))
          : null
        : await setQuantity(state, b.index ?? -1, b.quantity ?? 0)
    if (!r) return badRequest('variantId gerekli')
    log(r.traces)
    if (state.lineItems.length === 0) delete s.carts[seller]
    return NextResponse.json({ carts: cartsView(s.carts), notes: r.notes, traces: r.traces })
  } catch (e) {
    const t = (e as { details?: { trace?: CallTrace } }).details?.trace
    if (t) pushLog(s, { seller, tool: t.tool, auth: t.auth, surface: t.surface, endpoint: t.endpoint, request: t.request, error: (e as Error).message, validation: t.validation })
    // Roll back the local change the business rejected.
    state.lineItems = before
    if (state.lineItems.length === 0) delete s.carts[seller]
    return errorJson(e, { carts: cartsView(s.carts) })
  }
}
