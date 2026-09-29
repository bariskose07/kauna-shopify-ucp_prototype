import { NextResponse } from 'next/server'

import { maskPII } from '@/lib/mask'
import { getSession, normalizeSeller, observe, pushLog } from '@/lib/session'

export const dynamic = 'force-dynamic'

interface Body {
  seller?: string
  scenario?: string
  /** Payment page mode: A (Checkout Kit), B (window), C (ECP iframe). */
  mode?: string
  /** e.g. opened / blocked / ec.start / ec.complete / fallback-to-B */
  outcome?: string
  detail?: string
  /** Raw client-side event (ec.* payload etc.) — PII-masked before storing. */
  event?: unknown
}

// Client-side payment-page events (Checkout Kit / ECP / popup) land here so
// they show up in the same debug log and in "Bulguları kopyala".
export async function POST(req: Request) {
  const b = (await req.json()) as Body
  const s = await getSession()
  const seller = b.seller ? normalizeSeller(b.seller) : 'https://unknown.invalid'
  pushLog(s, {
    seller,
    tool: `client:${b.mode ?? '?'}:${b.outcome ?? 'event'}`,
    response: maskPII(b.event ?? null),
    notes: b.detail ? [b.detail] : undefined,
  })
  if (b.outcome) observe(s, { scenario: b.scenario, seller, kind: 'payment_mode', mode: b.mode, outcome: b.outcome, detail: b.detail })
  return NextResponse.json({ ok: true })
}
