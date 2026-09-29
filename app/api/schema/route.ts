import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { normalizeSeller } from '@/lib/session'
import { getInputSchema } from '@/lib/ucp/client'

export const dynamic = 'force-dynamic'

// Raw live inputSchema for one tool (debug / "verify field names" aid).
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams
  const seller = p.get('seller')
  const tool = p.get('tool')
  if (!seller || !tool) return badRequest('seller ve tool gerekli')
  try {
    return NextResponse.json({ tool, schema: await getInputSchema(normalizeSeller(seller), tool) })
  } catch (e) {
    return errorJson(e)
  }
}
