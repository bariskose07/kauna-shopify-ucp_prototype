import { NextResponse } from 'next/server'

import { findingsMarkdown } from '@/lib/findings'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function GET() {
  const s = await getSession()
  return NextResponse.json({ markdown: findingsMarkdown(s) })
}
