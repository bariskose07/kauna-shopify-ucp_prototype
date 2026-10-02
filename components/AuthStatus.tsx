'use client'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

type Mode = 'token' | 'none' | 'fallback' | 'cli'
interface AuthInfo {
  mode: Mode
  label: string
  note?: string
  profile?: string
}
export interface AuthStatusData {
  transport: string
  mcpProtocolVersion: string
  buyerIp?: { env: string | null }
  settings: { tokenlessFallback: boolean; cliTransport: boolean }
  profiles: { catalog: string; cartCheckout: string; override: { url: string; used: boolean; reason?: string } | null }
  token: {
    configured: boolean
    status: 'not-configured' | 'not-requested' | 'ok' | 'failed'
    credentialSource: string | null
    warning: string | null
    scopes: string[] | null
    limits: unknown
    expiresAt: number | null
    expiresInMin: number | null
    error: { message: string; httpStatus: number | null; at: number } | null
    rejected: { at: number; host: string; tool: string; message: string } | null
  }
  surfaces: {
    surface: string
    label: string
    needsToken: boolean
    expected: Mode
    expectedLabel: string
    blocked: boolean
    last: { auth: AuthInfo; ok: boolean; error?: string; authRejected: boolean; host: string; tool: string; at: number } | null
    rateLimitedFor: number | null
  }[]
}

// Bar text: "token ✓", "token yok (tasarım gereği)", "token yok – yedek ⚠".
const SHORT: Record<Mode, string> = {
  token: 'token',
  none: 'token yok (tasarım gereği)',
  fallback: 'token yok – yedek',
  cli: 'CLI (test)',
}

/**
 * Compact indicator under the header:
 *   Global Catalog: token ✓ · Mağaza katalog: token yok (tasarım gereği) · Sepet: token yok (tasarım gereği) · Checkout: token ✓
 * plus a persistent banner while the token cannot be obtained or is rejected.
 * Tap the row to expand details.
 */
export function AuthStatus() {
  const path = usePathname()
  const [s, setS] = useState<AuthStatusData | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () =>
      fetch('/api/auth-status', { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: AuthStatusData) => alive && setS(j))
        .catch(() => {})
    void load()
    const t = setInterval(load, 15_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [path])

  if (!s) return null
  const t = s.token
  const tokenProblem =
    t.status === 'failed'
      ? `Token alınamadı: ${t.error?.message ?? 'bilinmeyen neden'}${t.error?.httpStatus && !t.error.message.includes(`HTTP ${t.error.httpStatus}`) ? ` (HTTP ${t.error.httpStatus})` : ''}`
      : t.status === 'not-configured'
        ? 'Token alınamadı: SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET .env içinde tanımlı değil'
        : null
  // A rejection stays visible until a later token call on that surface succeeds.
  const rejectedStill =
    t.rejected && s.surfaces.some((x) => x.needsToken && x.last && x.last.at >= t.rejected!.at && !x.last.ok && x.last.authRejected)

  return (
    <div className="authbar">
      {tokenProblem && (
        <div className="authbar-alert" role="alert">
          <b>{tokenProblem}</b>
          <span>
            {' '}
            — Global Catalog ve Checkout istekleri{' '}
            {s.settings.tokenlessFallback ? "token'sız YEDEK olarak gönderiliyor (yalnızca test)." : 'gönderilmiyor.'}
          </span>
        </div>
      )}
      {rejectedStill && t.rejected && (
        <div className="authbar-alert" role="alert">
          <b>AuthenticationFailed</b> — {t.rejected.host} token’ı reddetti ({t.rejected.tool}).{' '}
          {s.settings.tokenlessFallback ? "Token'sız yedek denendi (test ayarı)." : "Token'sız tekrar denenmedi."}
        </div>
      )}
      {t.warning && <div className="authbar-alert warn">{t.warning}</div>}
      {s.settings.tokenlessFallback && (
        <div className="authbar-alert warn">Test ayarı açık: token reddedilir/alınamazsa istek token’sız tekrarlanır (“token yok – yedek”).</div>
      )}
      <button className="authbar-row" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Kimlik yolu ve son durum">
        {s.surfaces.map((x, i) => {
          const mode = x.last?.auth.mode ?? x.expected
          const failed = x.blocked || (x.last && !x.last.ok)
          const tone = x.rateLimitedFor ? 'warn' : failed ? 'bad' : x.last?.ok ? 'good' : 'idle'
          const mark = failed ? ' ✗' : x.last?.ok && mode !== 'none' ? ' ✓' : ''
          return (
            <span key={x.surface} className="authbar-item">
              {i > 0 && <span className="sep">·</span>}
              {x.label}:{' '}
              <b className={`mode ${mode}${failed ? " fail" : ""}`}>
                {SHORT[mode] ?? mode}
                {mode === 'fallback' ? ' ⚠' : ''}
                {mark}
              </b>
              <span className={`dot ${tone}`} aria-label={tone} />
              {x.rateLimitedFor ? <span className="rl">⏳ {Math.ceil(x.rateLimitedFor / 60)} dk</span> : null}
            </span>
          )
        })}
      </button>
      {open && (
        <div className="authbar-details small">
          <div>
            <b>Token</b>:{' '}
            {t.status === 'ok'
              ? `geçerli · ${t.expiresInMin} dk kaldı · kapsamlar: ${t.scopes?.length ? t.scopes.join(', ') : '(token içinde yok)'}`
              : t.status === 'not-requested'
                ? 'henüz istenmedi (ilk Global Catalog / Checkout isteğinde alınır)'
                : tokenProblem}
            {t.credentialSource ? <span className="muted"> · kaynak: {t.credentialSource}</span> : null}
          </div>
          <div>
            <b>Kural</b>: Global Catalog ve checkout araçları → Bearer token · mağaza kataloğu ve sepet araçları → token yok (tasarım gereği) ·
            MCP-Protocol-Version: {s.mcpProtocolVersion}
          </div>
          <div>
            <b>Shopify-Buyer-IP</b> (checkout çağrıları):{' '}
            {s.buyerIp?.env
              ? `UCP_BUYER_IP ${s.buyerIp.env} (istek genel bir IP'den gelmiyorsa)`
              : "isteğin genel IP'si; yerelde .env içine UCP_BUYER_IP=<genel IP> ekleyin"}
          </div>
          <div>
            <b>Profiller</b>: katalog <span className="mono">{s.profiles.catalog.split('/').slice(-2).join('/')}</span> · sepet/checkout{' '}
            <span className="mono">{s.profiles.cartCheckout.split('/').slice(-2).join('/')}</span>
            {s.profiles.override && !s.profiles.override.used ? (
              <span className="muted"> (UCP_AGENT_PROFILE_URL kullanılmadı: {s.profiles.override.reason ?? 'henüz denetlenmedi'})</span>
            ) : null}
          </div>
          {s.transport === 'cli' && (
            <div>
              <b>Taşıma</b>: CLI adaptörü (test ayarı) — tüm istekler @shopify/ucp-cli üzerinden
            </div>
          )}
          {s.surfaces.map((x) => (
            <div key={x.surface}>
              <b>{x.label}</b>: sıradaki istek <b>{x.expectedLabel}</b>
              {x.blocked ? <span className="bad-text"> — gönderilmeyecek (token yok)</span> : null}
              {x.last ? (
                <>
                  {' '}
                  · son: {x.last.tool} @ {x.last.host} [{x.last.auth.label}] → {x.last.ok ? 'başarılı' : x.last.error}
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
