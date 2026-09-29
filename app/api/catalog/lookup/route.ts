import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { getSession, pushLog } from '@/lib/session'
import { lookup } from '@/lib/ucp/catalog'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { ids, via } = (await req.json()) as { ids?: string[]; via?: string }
  if (!ids?.length) return badRequest('ids gerekli')
  const s = await getSession()
  try {
    const r = await lookup(ids.slice(0, 50), via)
    for (const t of r.traces)
      pushLog(s, { tool: t.tool, endpoint: t.endpoint, durationMs: t.durationMs, request: t.request, response: '[Catalog yanıtı sunucuda saklanmaz]' })
    return NextResponse.json(
      { products: r.data, messages: r.messages, dropped: r.dropped, traces: r.traces },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    return errorJson(e)
  }
}
