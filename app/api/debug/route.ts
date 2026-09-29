import { NextResponse } from 'next/server'

import { checkoutsSnapshot } from '@/lib/checkout-service'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function GET() {
  const s = await getSession()
  return NextResponse.json({
    log: s.log,
    checkouts: checkoutsSnapshot(s),
    observations: s.observations,
  })
}

export async function DELETE() {
  const s = await getSession()
  s.log = []
  s.observations = []
  return NextResponse.json({ ok: true })
}
