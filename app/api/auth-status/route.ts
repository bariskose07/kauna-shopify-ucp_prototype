import { NextResponse } from 'next/server'

import { config, getSurfaceStatus, getTokenState, rateLimitRemaining, type Surface } from '@/lib/ucp/client'

export const dynamic = 'force-dynamic'

const LABELS: Record<Surface, string> = {
  'global-catalog': 'Global Catalog',
  'merchant-catalog': 'Mağaza katalog',
  cart: 'Sepet',
  checkout: 'Checkout',
}

// Top-bar indicator: which identity tier each surface uses right now, the
// last observed result, token health and any active rate-limit back-off.
export async function GET() {
  const c = config()
  const token = getTokenState()
  const last = new Map(getSurfaceStatus().map((x) => [x.surface, x]))
  const merchantsGetToken = process.env.SHOPIFY_TOKEN_FOR_MERCHANTS === '1'

  const surfaces = (Object.keys(LABELS) as Surface[]).map((surface) => {
    const l = last.get(surface)
    // What the next request will use (config), independent of history.
    let expected: string
    if (c.transport === 'cli') expected = 'cli'
    else if (surface === 'global-catalog') expected = !c.hasClientCredentials ? 'anonymous' : token.status === 'failed' ? 'anonymous' : 'token'
    else expected = merchantsGetToken && c.hasClientCredentials ? 'token' : 'anonymous'
    const rl = l ? rateLimitRemaining(l.endpoint) : undefined
    return {
      surface,
      label: LABELS[surface],
      expected,
      last: l
        ? { auth: l.auth, ok: l.ok, error: l.error, host: l.host, tool: l.tool, at: l.at }
        : null,
      rateLimitedFor: rl ?? null,
    }
  })

  return NextResponse.json(
    {
      transport: c.transport,
      signed: { implemented: false, note: 'RFC 9421 imzalı istek uygulanmadı (ucp-cli 0.9.0 da imzalamıyor)' },
      token: {
        configured: token.configured,
        status: token.status,
        expiresInMin: token.expiresAt ? Math.round((token.expiresAt - Date.now()) / 60000) : null,
        error: token.error ? { message: token.error.message, httpStatus: token.error.httpStatus ?? null, at: token.error.at } : null,
      },
      surfaces,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
