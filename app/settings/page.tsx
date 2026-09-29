'use client'
import { useEffect, useState } from 'react'

import { api, getPaymentMode, setPaymentMode, type PaymentMode } from '@/lib/browser'

interface Config {
  transport: string
  auth: string
  profileOverride: string | null
  catalogUrl: string
  defaultSeller: string
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

  useEffect(() => {
    setMode(getPaymentMode())
    void api<Config>('/api/config').then(setCfg)
  }, [])

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
                <td>Agent profili</td>
                <td className="mono">{cfg.profileOverride ?? 'Shopify örnek profili (sürüme göre)'}</td>
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
