import { NextResponse } from 'next/server'

import { errorJson } from '@/lib/api'
import { assertInput, maskSecret, mobileUcpCheckout, type MobileCheckoutInput } from '@/lib/mobile-checkout'
import { DEFAULT_BUYER } from '@/lib/ucp/types'

export const dynamic = 'force-dynamic'

// NEW endpoint for mobile-harness/ (Expo). The existing web routes are untouched.
// Input: { seller, variantId, quantity?, buyer?, includePhone?, attemptId? }
// Output: status, totals, messages, continue_url, cartToken, cartKey, identity tier.
// Never call complete_checkout (enforced in lib/ucp/client.ts).
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Partial<MobileCheckoutInput>
  try {
    const input = { ...b, buyer: { ...DEFAULT_BUYER, ...(b.buyer ?? {}) } }
    assertInput(input)
    const r = await mobileUcpCheckout(input)
    // Server log: no key material (rule 5 of the harness spec).
    console.info(
      `[mobile] ${r.attemptId} ${new URL(r.seller).host} status=${r.status} cart=${maskSecret(r.cartToken)} key=${maskSecret(r.cartKey)} auth=${r.auth.map((a) => `${a.step}:${a.auth?.mode}`).join(',')}`,
    )
    return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return errorJson(e)
  }
}
