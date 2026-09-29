import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { updateCheckoutFlow, type UpdatePatch } from '@/lib/checkout-service'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

// Every update re-sends the whole checkout (PUT semantics) — see checkout.ts.
export async function POST(req: Request) {
  const b = (await req.json()) as UpdatePatch & { seller?: string }
  if (!b.seller) return badRequest('seller gerekli')
  const s = await getSession()
  try {
    return NextResponse.json(await updateCheckoutFlow(s, b.seller, b))
  } catch (e) {
    return errorJson(e)
  }
}
