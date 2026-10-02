import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { cancelCheckoutFlow } from '@/lib/checkout-service'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

// "Checkout'u iptal et": cancel_checkout (token tier). Never completes.
export async function POST(req: Request) {
  const { seller } = (await req.json().catch(() => ({}))) as { seller?: string }
  if (!seller) return badRequest('seller gerekli')
  const s = await getSession()
  try {
    return NextResponse.json(await cancelCheckoutFlow(s, seller))
  } catch (e) {
    return errorJson(e)
  }
}
