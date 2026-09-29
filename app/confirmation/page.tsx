'use client'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'

import { ApiFailure, api, formatMoney, sellerOrigin } from '@/lib/browser'
import type { CheckoutAnalysis } from '@/lib/ucp/analysis'
import type { CommerceObject } from '@/lib/ucp/types'

interface View {
  checkoutId?: string
  draftOrderId: string
  checkout?: CommerceObject
  analysis?: CheckoutAnalysis
}

// Draft of Kauna's own order-confirmation screen. It is only meaningful when
// get_checkout reports `completed` — which this prototype never causes.
function ConfirmationInner() {
  const seller = sellerOrigin(useSearchParams().get('seller') ?? '')
  const [v, setV] = useState<View | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!seller) return
    api<View>(`/api/checkout/status?seller=${encodeURIComponent(seller)}`)
      .then(setV)
      .catch((e) => setErr(e instanceof ApiFailure ? e.error.message : String(e)))
  }, [seller])

  if (err) return <div className="notice danger">{err}</div>
  if (!v) return <p className="muted">Durum sorgulanıyor…</p>
  const a = v.analysis
  const co = v.checkout
  const order = (co?.order ?? {}) as { id?: string; permalink_url?: string; [k: string]: unknown }
  const total = a?.totals.find((t) => t.type === 'total')

  if (!a?.completed) {
    return (
      <div className="card">
        <h1>Sipariş henüz tamamlanmadı</h1>
        <p>
          Checkout durumu: <span className="badge">{a?.status}</span>
        </p>
        <p className="muted small">Bu ekran, sipariş tamamlandığında gösterilecek Kauna onay ekranının taslağıdır.</p>
        <Link href={`/checkout?seller=${encodeURIComponent(seller)}`}>← Checkout’a dön</Link>
      </div>
    )
  }

  return (
    <div className="card">
      <h1>Siparişin alındı 🎉</h1>
      <p>
        <strong>{new URL(seller).host}</strong> siparişini aldı. Ödeme ve kargo mağaza tarafından yönetilir.
      </p>
      <table className="totals">
        <tbody>
          <tr>
            <td>Mağaza sipariş no</td>
            <td className="mono">{order.id ?? '—'}</td>
          </tr>
          <tr>
            <td>Kauna referansı</td>
            <td className="mono">{v.draftOrderId}</td>
          </tr>
          <tr className="total">
            <td>Toplam</td>
            <td>{formatMoney(total?.amount, co?.currency)}</td>
          </tr>
        </tbody>
      </table>
      {(co?.line_items ?? []).map((li) => (
        <div key={li.id} className="small">
          {li.item.title ?? li.item.id} × {li.quantity}
        </div>
      ))}
      {order.permalink_url && (
        <p>
          <a href={order.permalink_url} target="_blank" rel="noreferrer">
            Siparişi mağazada görüntüle →
          </a>
        </p>
      )}
      <div className="row small">
        {a.links.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
            {l.title ?? l.type}
          </a>
        ))}
      </div>
    </div>
  )
}

export default function ConfirmationPage() {
  return (
    <Suspense fallback={<p className="muted">Yükleniyor…</p>}>
      <ConfirmationInner />
    </Suspense>
  )
}
