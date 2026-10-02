import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { getSession, normalizeSeller, pushLog } from '@/lib/session'
import { searchGlobal, searchSeller } from '@/lib/ucp/catalog'

export const dynamic = 'force-dynamic'

// Catalog results are returned to the browser and never stored server-side
// (Shopify Catalog terms). Only a placeholder is written to the debug log.
export async function POST(req: Request) {
  const { query, seller } = (await req.json()) as { query?: string; seller?: string }
  if (!query?.trim()) return badRequest('query gerekli')
  const s = await getSession()
  try {
    const r = seller ? await searchSeller(normalizeSeller(seller), query) : await searchGlobal(query)
    for (const t of r.traces)
      pushLog(s, { seller, tool: t.tool, auth: t.auth, surface: t.surface, profile: t.profile, payloadSource: t.payloadSource, endpoint: t.endpoint, durationMs: t.durationMs, request: t.request, response: '[Catalog yanıtı sunucuda saklanmaz]' })
    return NextResponse.json(
      { products: r.data, messages: r.messages, notes: r.notes, dropped: r.dropped, traces: r.traces },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    return errorJson(e)
  }
}
