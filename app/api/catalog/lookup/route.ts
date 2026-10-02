import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { getSession, pushLog } from '@/lib/session'
import { lookupSmart } from '@/lib/ucp/catalog'
import { normalizeSeller } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { ids, seller } = (await req.json()) as { ids?: string[]; seller?: string }
  if (!ids?.length) return badRequest('ids gerekli')
  const s = await getSession()
  try {
    const r = await lookupSmart(ids.slice(0, 50), seller ? normalizeSeller(seller) : undefined)
    for (const t of r.traces)
      pushLog(s, { tool: t.tool, auth: t.auth, surface: t.surface, profile: t.profile, payloadSource: t.payloadSource, endpoint: t.endpoint, durationMs: t.durationMs, request: t.request, response: '[Catalog yanıtı sunucuda saklanmaz]' })
    return NextResponse.json(
      { products: r.data, messages: r.messages, dropped: r.dropped, traces: r.traces, notes: r.notes, report: r.report },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    return errorJson(e)
  }
}
