import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { estimateShipping } from '@/lib/estimate'
import { getSession, normalizeSeller } from '@/lib/session'
import { DEFAULT_BUYER } from '@/lib/ucp/types'

export const dynamic = 'force-dynamic'

// Product page: shipping cost for the buyer's saved (or default test) address,
// computed in the background — no redirect, nothing added to the real cart.
export async function POST(req: Request) {
  const { seller, variantId, allowCheckout } = (await req.json()) as { seller?: string; variantId?: string; allowCheckout?: boolean }
  if (!seller || !variantId) return badRequest('seller ve variantId gerekli')
  const s = await getSession()
  try {
    return NextResponse.json(await estimateShipping(s, normalizeSeller(seller), variantId, s.buyer ?? DEFAULT_BUYER, allowCheckout === true))
  } catch (e) {
    return errorJson(e)
  }
}
