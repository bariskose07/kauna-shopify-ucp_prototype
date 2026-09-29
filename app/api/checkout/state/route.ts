import { NextResponse } from 'next/server'

import { badRequest } from '@/lib/api'
import { getSession, normalizeSeller } from '@/lib/session'
import { analyzeCheckout } from '@/lib/ucp/analysis'
import { withUtm } from '@/lib/ucp/checkout'

export const dynamic = 'force-dynamic'

// Local state only (no UCP call) — lets the checkout page survive a reload.
export async function GET(req: Request) {
  const seller = new URL(req.url).searchParams.get('seller')
  if (!seller) return badRequest('seller gerekli')
  const s = await getSession()
  const d = s.checkouts[normalizeSeller(seller)]
  if (!d) return NextResponse.json({ draft: null, buyer: s.buyer ?? null })
  return NextResponse.json({
    buyer: d.buyer,
    draft: {
      seller: d.seller,
      checkoutId: d.checkoutId,
      draftOrderId: d.draftOrderId,
      checkout: d.last,
      analysis: d.last ? analyzeCheckout(d.last, { addressSent: false }) : undefined,
      continueUrl: withUtm(d.last?.continue_url, d.draftOrderId),
      rawContinueUrl: d.last?.continue_url,
      ucp: d.last?.ucp,
      phonePlacement: d.phonePlacement,
      includePhone: d.includePhone,
      discountCodes: d.discountCodes,
      scenario: d.scenario,
      buildNotes: d.buildNotes ?? [],
      traces: [],
    },
  })
}
