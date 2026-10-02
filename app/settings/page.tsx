'use client'
import { useEffect, useState } from 'react'

import { api, getPaymentMode, setPaymentMode, type PaymentMode } from '@/lib/browser'

interface Config {
  transport: string
  auth: string
  profileOverride: string | null
  profiles: { catalog: string; cartCheckout: string; override: { url: string; used: boolean; reason?: string } | null }
  mcpProtocolVersion: string
  settings: AuthSettings
  catalogUrl: string
  defaultSeller: string
}
interface AuthSettings {
  tokenlessFallback: boolean
  cliTransport: boolean
}

const MODES: { id: PaymentMode; title: string; desc: string }[] = [
  {
    id: 'A',
    title: 'A) Checkout Kit (web)',
    desc: '@shopify/checkout-kit 4.0.0-alpha.4 <shopify-checkout> bileşeni; popup + ec.* olayları. Alfa sürüm; olay gelmezse B’ye düşme önerilir.',
  },
  { id: 'B', title: 'B) Açılır pencere / yeni sekme', desc: 'continue_url ayrı pencerede. Mobilde uygulama içi tarayıcıya en yakın deneyim.' },
  { id: 'C', title: 'C) ECP iframe', desc: 'continue_url + ec_version ile iframe; ec.ready vb. JSON-RPC mesajları dinlenir. Mağaza iframe’i engelleyebilir.' },
]

export default function SettingsPage() {
  const [mode, setMode] = useState<PaymentMode>('B')
  const [cfg, setCfg] = useState<Config | null>(null)

  const load = () => void api<Config>('/api/config').then(setCfg)
  useEffect(() => {
    setMode(getPaymentMode())
    load()
  }, [])
  const toggle = async (patch: Partial<AuthSettings>) => {
    await api('/api/auth-status', { body: patch })
    load()
  }

  return (
    <>
      <h1>Ayarlar</h1>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Ödeme sayfası modu</h2>
        {MODES.map((m) => (
          <label key={m.id} className={`option ${mode === m.id ? 'on' : ''}`} style={{ color: 'inherit' }}>
            <input
              type="radio"
              name="mode"
              checked={mode === m.id}
              onChange={() => {
                setMode(m.id)
                setPaymentMode(m.id)
              }}
            />
            <span>
              <strong>{m.title}</strong>
              <div className="small muted">{m.desc}</div>
            </span>
          </label>
        ))}
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Kimlik (yalnızca test)</h2>
        <p className="small muted">
          Normal akış Shopify’ın kuralıdır: Global Catalog ve checkout araçları token ile, mağaza kataloğu ve sepet araçları token’sız. Token
          alınamaz ya da mağaza reddederse (AuthenticationFailed) istek durur ve hata gösterilir. Aşağıdakiler yalnızca teşhis içindir; açıkken
          yapılan çağrılar panelde ve günlükte “token yok – yedek” / “CLI (test)” olarak işaretlenir.
        </p>
        {cfg ? (
          <>
            <label className={`option ${cfg.settings.tokenlessFallback ? 'on' : ''}`} style={{ color: 'inherit' }}>
              <input
                type="checkbox"
                checked={cfg.settings.tokenlessFallback}
                onChange={(e) => void toggle({ tokenlessFallback: e.target.checked })}
              />
              <span>
                <strong>Token reddedilirse token’sız dene (yalnızca test)</strong>
                <div className="small muted">Varsayılan kapalı. Sunucu belleğinde tutulur; sunucu yeniden başlayınca kapanır.</div>
              </span>
            </label>
            <label className={`option ${cfg.settings.cliTransport ? 'on' : ''}`} style={{ color: 'inherit' }}>
              <input type="checkbox" checked={cfg.settings.cliTransport} onChange={(e) => void toggle({ cliTransport: e.target.checked })} />
              <span>
                <strong>CLI adaptörünü kullan (yalnızca test)</strong>
                <div className="small muted">Tüm UCP çağrıları @shopify/ucp-cli üzerinden yapılır (UCP_TRANSPORT=cli ile aynı). Varsayılan kapalı.</div>
              </span>
            </label>
          </>
        ) : (
          '…'
        )}
      </div>
      <div className="card small">
        <h2 style={{ marginTop: 0 }}>Sunucu yapılandırması</h2>
        {cfg ? (
          <table className="totals">
            <tbody>
              <tr>
                <td>Taşıma</td>
                <td className="mono">{cfg.transport}</td>
              </tr>
              <tr>
                <td>Kimlik doğrulama</td>
                <td className="mono">{cfg.auth}</td>
              </tr>
              <tr>
                <td>Profil (katalog)</td>
                <td className="mono">{cfg.profiles.catalog}</td>
              </tr>
              <tr>
                <td>Profil (sepet + checkout)</td>
                <td className="mono">
                  {cfg.profiles.cartCheckout}
                  {cfg.profiles.override && !cfg.profiles.override.used
                    ? ` (UCP_AGENT_PROFILE_URL kullanılmadı: ${cfg.profiles.override.reason ?? 'ilk istekte denetlenir'})`
                    : ''}
                </td>
              </tr>
              <tr>
                <td>MCP-Protocol-Version</td>
                <td className="mono">{cfg.mcpProtocolVersion}</td>
              </tr>
              <tr>
                <td>Global Catalog</td>
                <td className="mono">{cfg.catalogUrl}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          '…'
        )}
      </div>
    </>
  )
}
