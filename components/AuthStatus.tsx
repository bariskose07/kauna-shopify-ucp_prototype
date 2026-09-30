'use client'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

interface Status {
  transport: string
  token: { configured: boolean; status: string; expiresInMin: number | null; error: { message: string; httpStatus: number | null } | null }
  signed: { implemented: boolean; note: string }
  surfaces: {
    surface: string
    label: string
    expected: string
    last: { auth: { mode: string; note?: string }; ok: boolean; error?: string; host: string; tool: string; at: number } | null
    rateLimitedFor: number | null
  }[]
}

const MODE_TR: Record<string, string> = { token: 'token', signed: 'imzalı', anonymous: 'anonim', cli: 'CLI yedeği' }

/**
 * Compact indicator under the header:
 *   Global Catalog: token ✓ · Mağaza katalog: anonim · Sepet: anonim · Checkout: anonim ⏳ 58 dk
 * Tap to expand details (token failure reason, last error per surface).
 */
export function AuthStatus() {
  const path = usePathname()
  const [s, setS] = useState<Status | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () =>
      fetch('/api/auth-status', { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: Status) => alive && setS(j))
        .catch(() => {})
    void load()
    const t = setInterval(load, 15_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [path])

  if (!s) return null
  const tokenFailed = s.token.status === 'failed'

  return (
    <div className="authbar">
      <button className="authbar-row" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Kimlik yolu ve son durum">
        {s.surfaces.map((x, i) => {
          const mode = x.last?.auth.mode ?? x.expected
          const tone = x.rateLimitedFor ? 'warn' : x.last && !x.last.ok ? 'bad' : x.last?.ok ? 'good' : 'idle'
          return (
            <span key={x.surface} className="authbar-item">
              {i > 0 && <span className="sep">·</span>}
              {x.label}: <b className={`mode ${mode}`}>{MODE_TR[mode] ?? mode}</b>
              <span className={`dot ${tone}`} aria-label={tone} />
              {x.rateLimitedFor ? <span className="rl">⏳ {Math.ceil(x.rateLimitedFor / 60)} dk</span> : null}
            </span>
          )
        })}
        {tokenFailed && <span className="authbar-item bad-text">· Token başarısız</span>}
      </button>
      {open && (
        <div className="authbar-details small">
          <div>
            <b>Token</b>:{' '}
            {!s.token.configured
              ? 'yapılandırılmadı (SHOPIFY_CLIENT_ID/SECRET yok) → her şey anonim'
              : s.token.status === 'ok'
                ? `geçerli (${s.token.expiresInMin} dk kaldı) — yalnızca Global Catalog’a gönderiliyor`
                : s.token.status === 'failed'
                  ? `BAŞARISIZ${s.token.error?.httpStatus ? ` (HTTP ${s.token.error.httpStatus})` : ''}: ${s.token.error?.message} → Global Catalog anonim devam ediyor`
                  : 'henüz istenmedi (ilk Catalog isteğinde alınır)'}
          </div>
          <div>
            <b>İmzalı</b>: {s.signed.note}
          </div>
          {s.transport === 'cli' && (
            <div>
              <b>Taşıma</b>: UCP_TRANSPORT=cli — tüm istekler @shopify/ucp-cli üzerinden
            </div>
          )}
          {s.surfaces.map((x) => (
            <div key={x.surface}>
              <b>{x.label}</b>: sıradaki istek <b>{MODE_TR[x.expected] ?? x.expected}</b>
              {x.last ? (
                <>
                  {' '}
                  · son: {x.last.tool} @ {x.last.host} → {x.last.ok ? 'başarılı' : x.last.error}
                  {x.last.auth.note ? <span className="muted"> ({x.last.auth.note})</span> : null}
                </>
              ) : (
                <span className="muted"> · henüz istek yok</span>
              )}
              {x.rateLimitedFor ? <span> · hız limiti: {Math.ceil(x.rateLimitedFor / 60)} dk daha istek gönderilmeyecek</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
