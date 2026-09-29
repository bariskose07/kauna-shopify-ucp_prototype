'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import { ApiFailure, api, formatMoney } from '@/lib/browser'
import type { CommerceObject } from '@/lib/ucp/types'

interface CartView {
  seller: string
  cartId?: string
  cartSupported: boolean
  lineItems: { id?: string; item: { id: string }; quantity: number }[]
  last?: CommerceObject
}

export default function CartPage() {
  const [carts, setCarts] = useState<CartView[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void api<{ carts: CartView[] }>('/api/cart').then((r) => setCarts(r.carts))
  }, [])

  async function setQty(seller: string, index: number, quantity: number) {
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ carts: CartView[] }>('/api/cart', { body: { action: 'set', seller, index, quantity } })
      setCarts(r.carts)
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.error.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!carts) return <div className="skeleton" style={{ height: 160 }} />
  if (carts.length === 0)
    return (
      <>
        <h1>Sepet</h1>
        <div className="empty">
          Sepetin boş. <Link href="/">Ürün keşfet →</Link>
        </div>
      </>
    )

  return (
    <>
      <h1>Sepet</h1>
      {carts.length > 1 && (
        <div className="notice">
          Farklı satıcılardan ürünler var → her satıcı için <strong>ayrı sepet ve ayrı checkout</strong> oluşturulur (UCP
          satıcı bazlıdır).
        </div>
      )}
      {err && <div className="notice danger">{err}</div>}
      {carts.map((c) => {
        const byId = new Map((c.last?.line_items ?? []).map((li) => [li.id, li]))
        const subtotal = c.last?.totals?.find((t) => t.type === 'subtotal')
        return (
          <div key={c.seller} className="card">
            <div className="row">
              <strong className="grow">{new URL(c.seller).host}</strong>
              <span className="muted small mono">{c.cartId ? `cart ${c.cartId.slice(-10)}` : c.cartSupported ? '' : 'Cart MCP yok (yerel)'}</span>
            </div>
            {c.lineItems.map((l, i) => {
              const li = l.id ? byId.get(l.id) : undefined
              return (
                <div key={`${l.item.id}-${i}`} className="line-item">
                  {li?.item.image_url ? <img src={li.item.image_url} alt="" /> : <div className="ph" />}
                  <div className="grow small">
                    <div>{li?.item.title ?? <span className="mono">{l.item.id}</span>}</div>
                    {li?.item.price !== undefined && <div className="muted">{formatMoney(li.item.price, c.last?.currency)}</div>}
                  </div>
                  <button onClick={() => void setQty(c.seller, i, l.quantity - 1)} disabled={busy} aria-label="azalt" style={{ padding: '6px 12px' }}>
                    −
                  </button>
                  <span>{l.quantity}</span>
                  <button onClick={() => void setQty(c.seller, i, l.quantity + 1)} disabled={busy} aria-label="artır" style={{ padding: '6px 12px' }}>
                    +
                  </button>
                </div>
              )
            })}
            {c.last?.messages?.map((m, i) => (
              <div key={i} className={`notice small ${m.type === 'error' ? 'danger' : 'warn'}`}>
                {m.code}: {m.content}
              </div>
            ))}
            <div className="row" style={{ marginTop: 10 }}>
              <div className="grow small">
                {subtotal ? `Ara toplam (tahmini): ${formatMoney(subtotal.amount, c.last?.currency)}` : ''}
              </div>
              <Link className="btn primary" href={`/checkout?seller=${encodeURIComponent(c.seller)}`}>
                {new URL(c.seller).host} için ödeme →
              </Link>
            </div>
          </div>
        )
      })}
    </>
  )
}
