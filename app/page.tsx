'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { ProductCard } from '@/components/ProductCard'
import { ApiFailure, api, pushClientLog } from '@/lib/browser'
import { AAB_US, PRESETS } from '@/lib/scenarios'
import type { UiProduct } from '@/lib/ucp/catalog'

type Tab = 'global' | 'seller' | 'lookup'

interface SearchResp {
  products: UiProduct[]
  messages?: unknown[]
  notes?: string[]
  dropped?: { pointer: string }[]
  traces?: unknown[]
}

export default function SearchPage() {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('seller')
  const [query, setQuery] = useState('abaya')
  const [seller, setSeller] = useState(AAB_US)
  const [ids, setIds] = useState('')
  const [customVariant, setCustomVariant] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<SearchResp | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setErr(null)
    setRes(null)
    try {
      const r =
        tab === 'lookup'
          ? await api<SearchResp>('/api/catalog/lookup', {
              body: { ids: ids.split(/[\s,]+/).filter(Boolean) },
            })
          : await api<SearchResp>('/api/catalog/search', {
              body: { query, seller: tab === 'seller' ? seller : undefined },
            })
      pushClientLog({ tool: `catalog:${tab}`, payload: r.traces })
      setRes(r)
    } catch (e) {
      setErr(e instanceof ApiFailure ? `${e.error.message}${e.error.hint ? ` — ${e.error.hint}` : ''}` : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function quickBuy(p: (typeof PRESETS)[number]) {
    setBusy(true)
    setErr(null)
    try {
      await api('/api/cart', { body: { action: 'add', seller: p.seller, variantId: p.variantId, quantity: 1 } })
      router.push(`/checkout?seller=${encodeURIComponent(p.seller)}`)
    } catch (e) {
      setErr(e instanceof ApiFailure ? `${e.error.message}${e.error.hint ? ` — ${e.error.hint}` : ''}` : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Ürün ara</h1>
      <div className="card">
        <div className="chips" style={{ marginBottom: 10 }}>
          {(
            [
              ['seller', 'Satıcı + ürün adı'],
              ['global', 'Global Catalog (anlama göre)'],
              ['lookup', 'Kimlik / URL ile'],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button key={t} className={`chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void run()
          }}
          className="stack"
        >
          {tab === 'seller' && (
            <div className="field">
              <label>Satıcı alan adı</label>
              <input value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="us.aabcollection.com" />
            </div>
          )}
          {tab !== 'lookup' ? (
            <div className="field">
              <label>{tab === 'global' ? 'Ne arıyorsun? (anlama göre; marka adıyla aramak iyi sonuç vermez)' : 'Ürün adı'}</label>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="green tartan maxi dress" />
            </div>
          ) : (
            <div className="field">
              <label>Varyant/ürün kimlikleri veya ürün URL’leri (boşluk ya da virgülle)</label>
              <textarea
                rows={3}
                value={ids}
                onChange={(e) => setIds(e.target.value)}
                placeholder="gid://shopify/ProductVariant/54030028341562  https://us.aabcollection.com/products/..."
              />
            </div>
          )}
          <button className="primary" disabled={busy}>
            {busy ? 'Aranıyor…' : 'Ara'}
          </button>
        </form>
      </div>

      <details className="card">
        <summary>
          <strong>Hazır test ürünleri</strong> <span className="muted small">(doğrudan checkout)</span>
        </summary>
        <div className="stack" style={{ marginTop: 10 }}>
          {PRESETS.map((p) => (
            <div key={p.variantId} className="row">
              <div className="grow">
                <div>{p.label}</div>
                <div className="muted small mono">
                  {new URL(p.seller).host} · {p.variantId.split('/').pop()}
                </div>
                {p.note && <div className="muted small">{p.note}</div>}
              </div>
              <button onClick={() => void quickBuy(p)} disabled={busy}>
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
              void quickBuy({
                label: 'custom',
                seller,
                variantId: /^\d+$/.test(id) ? `gid://shopify/ProductVariant/${id}` : id,
              })
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
            Not: aabcollection.com örnekleri kullanıcıdan gelen products.json verisinden alındı; bu kimliklerin
            us.aabcollection.com mağazasında da geçerli olup olmadığı “Satıcı + ürün adı” aramasıyla doğrulanmalı.
          </p>
        </div>
      </details>

      {err && <div className="notice danger">{err}</div>}
      {res?.notes?.map((n) => (
        <div key={n} className="notice small">
          {n}
        </div>
      ))}
      {res?.dropped && res.dropped.length > 0 && (
        <div className="notice warn small">
          Şemada olmadığı için gönderilmeyen alanlar: {res.dropped.map((d) => d.pointer).join(', ')}
        </div>
      )}
      {res && res.products.length === 0 && <div className="notice">Sonuç yok. Farklı kelimeler deneyin.</div>}
      {res && res.products.length > 0 && (
        <div className="products">
          {res.products.map((p) => (
            <ProductCard key={`${p.id}-${p.via}`} p={p} />
          ))}
        </div>
      )}
    </>
  )
}
