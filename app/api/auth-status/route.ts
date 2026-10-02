import { NextResponse } from 'next/server'

import {
  AUTH_LABEL,
  MCP_PROTOCOL_VERSION,
  config,
  getAuthSettings,
  getSurfaceStatus,
  getTokenState,
  profileStatus,
  rateLimitRemaining,
  setAuthSettings,
  type AuthMode,
  type Surface,
} from '@/lib/ucp/client'

export const dynamic = 'force-dynamic'

const LABELS: Record<Surface, string> = {
  'global-catalog': 'Global Catalog',
  'merchant-catalog': 'Mağaza katalog',
  cart: 'Sepet',
  checkout: 'Checkout',
}
// Shopify's per-call rule (Authenticate your agent).
const NEEDS_TOKEN: Record<Surface, boolean> = { 'global-catalog': true, 'merchant-catalog': false, cart: false, checkout: true }

// Top-bar indicator + debug panel: token health (scopes, expiry, limits —
// never the token), the auth path each surface uses, test settings.
export async function GET() {
  const c = config()
  const token = getTokenState()
  const st = getAuthSettings()
  const last = new Map(getSurfaceStatus().map((x) => [x.surface, x]))

  const surfaces = (Object.keys(LABELS) as Surface[]).map((surface) => {
    const l = last.get(surface)
    // What the next request will use, independent of history.
    let expected: AuthMode
    let blocked = false
    if (c.transport === 'cli') expected = 'cli'
    else if (!NEEDS_TOKEN[surface]) expected = 'none'
    else if (token.status === 'failed' || token.status === 'not-configured') {
      expected = st.tokenlessFallback ? 'fallback' : 'token'
      blocked = !st.tokenlessFallback
    } else expected = 'token'
    const rl = l ? rateLimitRemaining(l.endpoint) : undefined
    return {
      surface,
      label: LABELS[surface],
      needsToken: NEEDS_TOKEN[surface],
      expected,
      expectedLabel: AUTH_LABEL[expected],
      /** Next call will not be sent (token missing and fallback off). */
      blocked,
      last: l
        ? { auth: l.auth, ok: l.ok, error: l.error, authRejected: l.authRejected ?? false, host: l.host, tool: l.tool, at: l.at }
        : null,
      rateLimitedFor: rl ?? null,
    }
  })

  return NextResponse.json(
    {
      transport: c.transport,
      mcpProtocolVersion: MCP_PROTOCOL_VERSION,
      settings: st,
      profiles: profileStatus(),
      token: {
        configured: token.configured,
        status: token.status,
        credentialSource: token.credentialSource ?? null,
        warning: token.warning ?? null,
        scopes: token.scopes ?? null,
        limits: token.limits ?? null,
        expiresAt: token.expiresAt ?? null,
        obtainedAt: token.obtainedAt ?? null,
        expiresInMin: token.expiresAt ? Math.round((token.expiresAt - Date.now()) / 60000) : null,
        error: token.error ? { message: token.error.message, httpStatus: token.error.httpStatus ?? null, at: token.error.at } : null,
        rejected: token.rejected ?? null,
      },
      surfaces,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

// Test-only switches (Ayarlar → "Kimlik (yalnızca test)"). Both default off.
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { tokenlessFallback?: unknown; cliTransport?: unknown }
  const next = setAuthSettings({
    tokenlessFallback: typeof b.tokenlessFallback === 'boolean' ? b.tokenlessFallback : undefined,
    cliTransport: typeof b.cliTransport === 'boolean' ? b.cliTransport : undefined,
  })
  return NextResponse.json({ settings: next })
}
