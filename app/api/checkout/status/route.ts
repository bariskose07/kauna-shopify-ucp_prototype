import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { getCheckoutFlow } from '@/lib/checkout-service'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

// "Durumu kontrol et" after the payment window closes: get_checkout.
export async function GET(req: Request) {
  const seller = new URL(req.url).searchParams.get('seller')
  if (!seller) return badRequest('seller gerekli')
  const s = await getSession()
  try {
    return NextResponse.json(await getCheckoutFlow(s, seller))
  } catch (e) {
    return errorJson(e)
  }
}
