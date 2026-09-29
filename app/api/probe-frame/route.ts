import { NextResponse } from 'next/server'

import { badRequest } from '@/lib/api'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

// Mode C helper: can this continue_url be framed at all? Reads
// X-Frame-Options / CSP frame-ancestors. Only URLs whose host matches a
// continue_url this session received are probed (no open proxy / SSRF).
export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get('url')
  if (!url) return badRequest('url gerekli')
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return badRequest('geçersiz url')
  }
  const s = await getSession()
  const allowed = Object.values(s.checkouts)
    .map((c) => c.last?.continue_url)
    .filter(Boolean)
    .map((u) => new URL(u as string).host)
  if (target.protocol !== 'https:' || !allowed.includes(target.host)) {
    return badRequest('Yalnızca bu oturumdaki continue_url adresleri kontrol edilebilir')
  }
  try {
    const res = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'kauna-ucp-prototype/0.1' } })
    await res.body?.cancel()
    const xfo = res.headers.get('x-frame-options')
    const csp = res.headers.get('content-security-policy') ?? ''
    const fa = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-ancestors'))
    const blocked = Boolean(xfo && /deny|sameorigin/i.test(xfo)) || Boolean(fa && !/\*|https:/.test(fa))
    return NextResponse.json({
      status: res.status,
      finalUrl: res.url,
      xFrameOptions: xfo,
      frameAncestors: fa ?? null,
      likelyBlocked: blocked,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 })
  }
}
