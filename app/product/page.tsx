'use client'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'

import { ApiFailure, api, formatMoney, pushClientLog } from '@/lib/browser'
import type { ShippingEstimate } from '@/lib/estimate'
import type { UiProduct, UiVariant } from '@/lib/ucp/catalog'

interface ProductResp {
  product: UiProduct | null
  messages?: { type?: string; code?: string; content?: string }[]
  notes?: string[]
  traces?: unknown[]
}

type Sel = { name: string; label: string }[]

function ProductInner() {
  const q = useSearchParams()
  const router = useRouter()
  const id = q.get('id') ?? undefined
  const via = q.get('via') ?? undefined
  const seller = q.get('seller') ?? undefined
  const handle = q.get('handle') ?? undefined

  const [data, setData] = useState<ProductResp | null>(null)
  const [selected, setSelected] = useState<Sel>([])
  const [qty, setQty] = useState(1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const load = useCallback(
    async (sel: Sel) => {
      setBusy(true)
      setErr(null)
      try {
        const r = await api<ProductResp>('/api/catalog/product', { body: { id, via, seller, handle, selected: sel } })
        pushClientLog({ tool: 'catalog:get_product', payload: r.traces })
        setData(r)
        if (r.product && sel.length === 0 && r.product.selected.length > 0) setSelected(r.product.selected)
      } catch (e) {
        setErr(e instanceof ApiFailure ? `${e.error.message}${e.error.hint ? ` — ${e.error.hint}` : ''}` : String(e))
      } finally {
        setBusy(false)
      }
    },
    [id, via, seller, handle],
  )

  useEffect(() => {
    void load([])
  }, [load])

  const p = data?.product
  const isStorefront = p?.source === 'storefront-products-json'

  // Catalog: the server narrows variants to the selection (featured = first).
  // products.json: match locally on option labels.
  const variant: UiVariant | undefined = useMemo(() => {
    if (!p) return undefined
    if (!isStorefront) return p.variants[0]
    return (
      p.variants.find((v) => selected.every((s) => v.options.some((o) => o.name === s.name && o.label === s.label))) ??
      p.variants[0]
    )
  }, [p, isStorefront, selected])

  function choose(name: string, label: string) {
    const next = [...selected.filter((s) => s.name !== name), { name, label }]
    setSelected(next)
    // Copy labels verbatim from options[] — re-query get_product with `selected`.
    if (!isStorefront) void load(next)
  }

  // Route cart/checkout to the seller's API handle — never to the catalog.
  const sellerDomain = variant?.sellerDomain ?? p?.sellerDomain
  const sellerUrl = sellerDomain ? `https://${sellerDomain}` : undefined

  // ── Shipping estimate in the background (no click, no redirect) ─────────
  const [estimate, setEstimate] = useState<ShippingEstimate | null>(null)
  const [estLoading, setEstLoading] = useState(false)
  useEffect(() => {
    if (!variant?.id || !sellerUrl || variant.available === false) return
    let stale = false
    setEstimate(null)
    setEstLoading(true)
    const t = setTimeout(() => {
      api<ShippingEstimate>('/api/shipping-estimate', { body: { seller: sellerUrl, variantId: variant.id } })
        .then((r) => !stale && setEstimate(r))
        .catch((e) =>
          !stale &&
          setEstimate({ source: 'none', choices: [], destination: '', messages: [], notes: [e instanceof ApiFailure ? e.error.message : String(e)] }),
        )
        .finally(() => !stale && setEstLoading(false))
    }, 400)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [variant?.id, variant?.available, sellerUrl])

  // ── "Satın al": create the checkout with the saved buyer and open the
  // merchant's pre-filled payment page straight away. The window is opened
  // synchronously inside the click so popup blockers allow it, then pointed
  // at continue_url once the checkout exists.
  async function buyNow() {
    if (!variant || !sellerUrl) return
    const w = window.open('', '_blank')
    if (w) {
      try {
        w.opener = null
        w.document.write(
          '<p style="font:16px system-ui;padding:24px">Mağazanın ödeme sayfası hazırlanıyor…<br><b style="color:#b3261e">TEST – “Pay now”a basma.</b></p>',
        )
      } catch {
        /* ignore */
      }
    }
    setBusy(true)
    setErr(null)
    try {
      await api('/api/cart', { body: { action: 'add', seller: sellerUrl, variantId: variant.id, quantity: qty } })
      const v = await api<{ continueUrl?: string }>('/api/checkout', { body: { seller: sellerUrl, includePhone: true } })
      if (v.continueUrl) {
        if (w && !w.closed) w.location.href = v.continueUrl
        else window.open(v.continueUrl, '_blank', 'noopener')
      } else {
        w?.close()
      }
      // Kauna's own summary stays here: totals, messages, status check.
      router.push(`/checkout?seller=${encodeURIComponent(sellerUrl)}`)
    } catch (e) {
      w?.close()
      setErr(e instanceof ApiFailure ? `${e.error.message}${e.error.hint ? ` — ${e.error.hint}` : ''}` : String(e))
      setBusy(false)
    }
  }

  async function add(goCheckout: boolean) {
    if (!variant || !sellerUrl) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ notes?: string[] }>('/api/cart', {
        body: { action: 'add', seller: sellerUrl, variantId: variant.id, quantity: qty },
      })
      if (goCheckout) router.push(`/checkout?seller=${encodeURIComponent(sellerUrl)}`)
      else setInfo(['Sepete eklendi.', ...(r.notes ?? [])].join(' '))
    } catch (e) {
      setErr(e instanceof ApiFailure ? `${e.error.message}${e.error.hint ? ` — ${e.error.hint}` : ''}` : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!p) return <>{err ? <div className="notice danger">{err}</div> : <p className="muted">Yükleniyor…</p>}</>

  return (
    <>
      <div className="pdp">
        <div className="gallery">
          {/* Live CDN URLs from the response; nothing is cached server-side. */}
          {p.media.map((m) => (
            <img key={m.url} src={m.url} alt={m.alt ?? p.title} />
          ))}
        </div>
        <div>
          <h1>{p.title}</h1>
          <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>
            {formatMoney(variant?.price.amount, variant?.price.currency)}{' '}
            {variant?.compareAt?.amount ? (
              <s className="muted small">{formatMoney(variant.compareAt.amount, variant.compareAt.currency)}</s>
            ) : null}
          </div>
          <div className="muted small">Para birimi: {variant?.price.currency ?? 'bilinmiyor (products.json)'}</div>

          <div className="notice small" style={{ marginTop: 8 }}>
            {estLoading && 'Kargo ücreti hesaplanıyor…'}
            {!estLoading && estimate && (estimate.amount !== undefined || estimate.choices.some((c) => c.options.length)) && (
              <>
                <strong>
                  Kargo{estimate.destination ? ` (${estimate.destination})` : ''}:{' '}
                  {estimate.amount !== undefined ? formatMoney(estimate.amount, estimate.currency) : 'seçeneğe göre'}
                </strong>
                {estimate.choices.flatMap((c) => c.options).map((o) => (
                  <div key={o.id}>
                    {o.title ?? o.id}: {o.amount !== undefined ? formatMoney(o.amount, estimate.currency) : '—'}
                    {o.estimate ? ` · ${o.estimate}` : ''}
                  </div>
                ))}
                <div className="muted">
                  Kaynak: {estimate.source === 'cart' ? 'sepet tahmini' : 'mağaza checkout’u'} · adres: kayıtlı / test adresi
                </div>
              </>
            )}
            {!estLoading && estimate && estimate.amount === undefined && !estimate.choices.some((c) => c.options.length) && (
              <>
                Kargo ödeme adımında hesaplanır.
                {estimate.notes.length > 0 && <div className="muted">{estimate.notes.join(' · ')}</div>}
              </>
            )}
          </div>

          {p.options.length > 0 &&
            p.options.map((o) => (
              <div key={o.name} className="field" style={{ marginTop: 10 }}>
                <label>{o.name}</label>
                <div className="chips">
                  {o.values
                    .filter((v) => v.exists !== false)
                    .map((v) => {
                      const on = selected.some((s) => s.name === o.name && s.label === v.label)
                      return (
                        <button
                          key={v.label}
                          className={`chip ${on ? 'on' : ''} ${v.available === false ? 'off' : ''}`}
                          onClick={() => choose(o.name, v.label)}
                          disabled={busy}
                          title={v.available === false ? 'Stokta yok' : ''}
                        >
                          {v.label}
                        </button>
                      )
                    })}
                </div>
              </div>
            ))}
          {p.options.length === 0 && p.variants.length > 1 && (
            <div className="notice small">Satıcı yapılandırılmış seçenek matrisi vermiyor; öne çıkan varyant kullanılıyor.</div>
          )}

          <div className="card small" style={{ marginTop: 10 }}>
            <div>
              Varyant: <span className="mono">{variant?.id}</span> {variant?.title ? `(${variant.title})` : ''}
            </div>
            <div>
              Stok:{' '}
              {variant?.available === true ? (
                <span className="badge ok">var{variant.runningLow ? ' · az kaldı' : ''}</span>
              ) : variant?.available === false ? (
                <span className="badge danger">yok</span>
              ) : (
                <span className="badge">bilinmiyor</span>
              )}{' '}
              {variant?.availabilityStatus && <span className="muted">({variant.availabilityStatus})</span>}
            </div>
            <div>
              eligible.native_checkout:{' '}
              <span className={`badge ${variant?.nativeCheckout === false ? 'warn' : variant?.nativeCheckout ? 'ok' : ''}`}>
                {String(variant?.nativeCheckout ?? 'bilinmiyor')}
              </span>
              {variant?.nativeCheckout === false && (
                <div className="muted">
                  false = sipariş API ile tamamlanamaz; checkout yine oluşturulur, ödeme mağazanın sayfasında yapılır.
                </div>
              )}
            </div>
            <div>
              Satıcı: <span className="mono">{variant?.sellerDomain ?? '—'}</span>{' '}
              {variant?.sellerName ? `(${variant.sellerName})` : ''}
            </div>
            <div className="muted">Kaynak: {p.source}</div>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              style={{ width: 80 }}
              aria-label="Adet"
            />
            <button onClick={() => void add(false)} disabled={busy || !variant || variant.available === false}>
              Sepete ekle
            </button>
            <button className="primary" onClick={() => void buyNow()} disabled={busy || !variant || !sellerUrl || variant.available === false}>
              {busy ? 'Hazırlanıyor…' : 'Satın al'}
            </button>
          </div>
          {variant?.checkoutUrl && (
            <p className="small" style={{ marginTop: 8 }}>
              Yedek:{' '}
              {/* Catalog's merchant-hosted buy-now link — no UCP checkout involved. */}
              <a href={variant.checkoutUrl} target="_blank" rel="noopener noreferrer">
                Mağazanın ödeme sayfasına doğrudan git (checkout_url) →
              </a>{' '}
              <span className="muted">UCP checkout’u oluşturulamazsa kullan; özet/kargo Kauna’da gösterilmez.</span>
            </p>
          )}
          {info && <div className="notice ok small">{info}</div>}
          {err && <div className="notice danger small">{err}</div>}
          {data?.notes?.map((n) => (
            <div key={n} className="notice small">
              {n}
            </div>
          ))}
          {data?.messages?.map((m, i) => (
            <div key={i} className="notice warn small">
              {m.code}: {m.content}
            </div>
          ))}
          {p.description && <p className="small" style={{ marginTop: 12 }}>{p.description.slice(0, 900)}</p>}
        </div>
      </div>
    </>
  )
}

export default function ProductPage() {
  return (
    <Suspense fallback={<p className="muted">Yükleniyor…</p>}>
      <ProductInner />
    </Suspense>
  )
}
