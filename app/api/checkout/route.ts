import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { createCheckoutFlow } from '@/lib/checkout-service'
import { getSession } from '@/lib/session'
import { DEFAULT_BUYER, type BuyerInfo } from '@/lib/ucp/types'

export const dynamic = 'force-dynamic'

interface Body {
  seller: string
  buyer?: Partial<BuyerInfo>
  includePhone?: boolean
  discountCodes?: string[]
  scenario?: string
  injectWrongField?: boolean
}

// "Satın al": create the checkout (from the seller's cart) and immediately
// push the full payload with the shipping destination.
export async function POST(req: Request) {
  const b = (await req.json()) as Body
  if (!b.seller) return badRequest('seller gerekli')
  const s = await getSession()
  try {
    const v = await createCheckoutFlow(s, {
      seller: b.seller,
      // Saved buyer (from an earlier checkout) pre-fills the merchant page.
      buyer: { ...DEFAULT_BUYER, ...(s.buyer ?? {}), ...(b.buyer ?? {}) },
      includePhone: b.includePhone ?? true,
      discountCodes: (b.discountCodes ?? []).filter(Boolean),
      scenario: b.scenario || undefined,
      injectWrongField: b.injectWrongField,
    })
    return NextResponse.json(v)
  } catch (e) {
    const partial = (e as { details?: { view?: unknown } }).details?.view
    return errorJson(e, partial ? { view: partial } : {})
  }
}
