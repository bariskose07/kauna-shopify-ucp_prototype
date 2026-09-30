'use client'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useState } from 'react'

import { ProductCard } from '@/components/ProductCard'
import { ApiFailure, api, pushClientLog } from '@/lib/browser'
import { AAB_US, PRESETS } from '@/lib/scenarios'
import type { UiProduct } from '@/lib/ucp/catalog'

type Tab = 'global' | 'seller' | 'lookup'

interface SearchResp {
  products: UiProduct[]
  messages?: { code?: string; content?: string }[]
  notes?: string[]
  dropped?: { pointer: string }[]
  traces?: unknown[]
}

const TABS: [Tab, string][] = [
  ['seller', 'Mağazada ara'],
  ['global', 'Tüm Shopify'],
  ['lookup', 'Kimlik / URL'],
]

const errText = (e: unknown) =>
  e instanceof ApiFailure ? `${e.error.message}${e.error.hint ? ` — ${e.error.hint}` : ''}` : String(e)

function SearchInner() {
  const router = useRouter()
  const params = useSearchParams()
  // The query lives in the URL so "back" from a product re-runs the search
  // (results are never stored — Catalog terms).
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'seller')
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [seller, setSeller] = useState(params.get('seller') ?? AAB_US)
  const [ids, setIds] = useState(params.get('ids') ?? '')
  const [customVariant, setCustomVariant] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<SearchResp | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const run = useCallback(async (t: Tab, q: string, sel: string, idList: string) => {
    setBusy(true)
    setErr(null)
    setRes(null)
    try {
      const r =
        t === 'lookup'
          ? await api<SearchResp>('/api/catalog/lookup', { body: { ids: idList.split(/[\s,]+/).filter(Boolean), seller: sel || undefined } })
          : await api<SearchResp>('/api/catalog/search', { body: { query: q, seller: t === 'seller' ? sel : undefined } })
      pushClientLog({ tool: `catalog:${t}`, payload: r.traces })
      setRes(r)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }, [])

  // Re-run a search that is in the URL (e.g. after navigating back).
  useEffect(() => {
    const q = params.get('q')
    const i = params.get('ids')
    if (q || i) void run((params.get('tab') as Tab) || 'seller', q ?? '', params.get('seller') ?? AAB_US, i ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function submit() {
    if (tab === 'lookup' ? !ids.trim() : !query.trim()) return
    const sp = new URLSearchParams({ tab })
    if (tab === 'lookup') sp.set('ids', ids)
    else sp.set('q', query)
    if (tab !== 'global') sp.set('seller', seller)
    router.replace(`/?${sp.toString()}`, { scroll: false })
    void run(tab, query, seller, ids)
  }

  async function quickBuy(sellerUrl: string, variantId: string) {
    setBusy(true)
    setErr(null)
    try {
      // `ensure`: repeated clicks don't bump the quantity.
      await api('/api/cart', { body: { action: 'ensure', seller: sellerUrl, variantId, quantity: 1 } })
      router.push(`/checkout?seller=${encodeURIComponent(sellerUrl)}`)
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Kauna içinde satın alma · Shopify UCP</p>
        <h1>Tesettür modasını keşfet, Kauna’dan ayrılmadan satın al</h1>
        <p>Ürünü bul, kargoyu ve toplamı burada gör; ödeme markanın kendi sayfasında.</p>
      </section>

      <div className="card">
        <div className="seg" role="tablist" style={{ marginBottom: 14 }}>
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          {(tab === 'seller' || tab === 'lookup') && (
            <div className="field">
              <label htmlFor="seller">{tab === 'lookup' ? 'Mağaza (Global Catalog’da bulunamazsa burada aranır)' : 'Mağaza alan adı'}</label>
              <input id="seller" value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="us.aabcollection.com" />
            </div>
          )}
          {tab === 'lookup' ? (
            <div className="field">
              <label htmlFor="ids">Varyant/ürün kimlikleri veya ürün adresleri</label>
              <textarea
                id="ids"
                rows={3}
                value={ids}
                onChange={(e) => setIds(e.target.value)}
                placeholder="gid://shopify/ProductVariant/54030028341562"
              />
            </div>
          ) : null}
          <div className="searchbar">
            {tab !== 'lookup' && (
              <input
                aria-label="Ara"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === 'global' ? 'ör. zeytin yeşili ekose maxi elbise' : 'ör. Green Tartan Maxi'}
              />
            )}
            <button className="primary" disabled={busy} style={tab === 'lookup' ? { width: '100%' } : undefined}>
              {busy ? 'Aranıyor…' : 'Ara'}
            </button>
          </div>
          {tab === 'global' && (
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              Tüm Shopify araması anlama göre çalışır; marka adı yerine ürünü tarif edin.
            </p>
          )}
        </form>
      </div>

      {err && <div className="notice danger">{err}</div>}
      {res?.notes?.map((n) => (
        <div key={n} className="notice small">
          {n}
        </div>
      ))}
      {res?.dropped && res.dropped.length > 0 && (
        <div className="notice warn small">Şemada olmadığı için gönderilmeyen alanlar: {res.dropped.map((d) => d.pointer).join(', ')}</div>
      )}
      {res?.messages?.map((m, i) => (
        <div key={i} className="notice warn small">
          {m.code}: {m.content}
        </div>
      ))}

      {busy && (
        <div className="products" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ aspectRatio: '3/4.6' }} />
          ))}
        </div>
      )}
      {res && res.products.length === 0 && <div className="empty">Sonuç yok. Farklı kelimeler deneyin.</div>}
      {res && res.products.length > 0 && (
        <>
          <p className="small muted">{res.products.length} ürün</p>
          <div className="products">
            {res.products.map((p) => (
              <ProductCard key={`${p.id}-${p.via}`} p={p} />
            ))}
          </div>
        </>
      )}

      <details className="card" style={{ marginTop: 20 }}>
        <summary>Hazır test ürünleri</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          {PRESETS.map((p) => (
            <div key={p.variantId} className="row">
              <div className="grow">
                <div>{p.label}</div>
                <div className="muted small mono">
                  {new URL(p.seller).host} · {p.variantId.split('/').pop()}
                </div>
                {p.note && <div className="muted small">{p.note}</div>}
              </div>
              <button onClick={() => void quickBuy(p.seller, p.variantId)} disabled={busy}>
                Checkout’a git
              </button>
            </div>
          ))}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              const id = customVariant.trim()
              if (!id) return
              void quickBuy(seller, /^\d+$/.test(id) ? `gid://shopify/ProductVariant/${id}` : id)
            }}
          >
            <input className="grow" value={seller} onChange={(e) => setSeller(e.target.value)} aria-label="Satıcı" />
            <input
              className="grow"
              value={customVariant}
              onChange={(e) => setCustomVariant(e.target.value)}
              placeholder="Varyant kimliği (GID veya sayı)"
              aria-label="Varyant kimliği"
            />
            <button disabled={busy}>Checkout’a git</button>
          </form>
          <p className="muted small">
            aabcollection.com örnekleri kullanıcının products.json verisinden alındı; us.aabcollection.com’da geçerliliği
            “Mağazada ara” ile doğrulanmalı.
          </p>
        </div>
      </details>
    </>
  )
}

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchInner />
    </Suspense>
  )
}
