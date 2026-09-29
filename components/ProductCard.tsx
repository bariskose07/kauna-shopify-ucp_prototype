'use client'
import Link from 'next/link'

import { formatMoney } from '@/lib/browser'
import type { UiProduct } from '@/lib/ucp/catalog'

export function productHref(p: UiProduct): string {
  if (p.source === 'storefront-products-json' && p.handle) {
    return `/product?seller=${encodeURIComponent(p.via)}&handle=${encodeURIComponent(p.handle)}`
  }
  return `/product?id=${encodeURIComponent(p.id)}&via=${encodeURIComponent(p.via)}`
}

/** Brand-facing host (seller.url) when known, else the API handle. */
function sellerLabel(p: UiProduct): string {
  const v = p.variants.find((x) => x.sellerDomain) ?? p.variants[0]
  const url = v?.sellerUrl ?? p.sellerUrl
  if (url) {
    try {
      return new URL(url.startsWith('http') ? url : `https://${url}`).host.replace(/^www\./, '')
    } catch {
      /* fall through */
    }
  }
  return v?.sellerDomain ?? p.sellerDomain ?? '—'
}

export function ProductCard({ p }: { p: UiProduct }) {
  const v = p.variants[0]
  const img = p.media[0]
  const domain = v?.sellerDomain ?? p.sellerDomain
  const label = sellerLabel(p)
  return (
    <Link href={productHref(p)} className="product-card">
      <div className="img">
        {/* Image straight from Shopify's CDN URL — never proxied or cached by us. */}
        {img ? <img src={img.url} alt={img.alt ?? p.title} loading="lazy" /> : null}
      </div>
      <div className="body">
        <div className="title">{p.title}</div>
        <div className="price">
          {formatMoney(p.priceMin.amount, p.priceMin.currency)}{' '}
          <span className="muted small" style={{ fontWeight: 400 }}>
            {p.priceMin.currency ?? ''}
          </span>
        </div>
        <div className="seller-chip" title={domain ? `seller.domain: ${domain}` : undefined}>
          <span aria-hidden>🏷</span>
          <span>{p.sellerName ?? v?.sellerName ?? label}</span>
        </div>
        {domain && domain !== label && (
          <div className="muted small mono" style={{ fontSize: 11 }}>
            {domain}
          </div>
        )}
        <div className="row small" style={{ marginTop: 'auto', paddingTop: 4, gap: 4 }}>
          {v?.nativeCheckout === false && <span className="badge warn">Ödeme mağazada</span>}
          {v?.nativeCheckout === true && <span className="badge ok">native_checkout</span>}
          {p.source === 'storefront-products-json' && <span className="badge">products.json</span>}
        </div>
      </div>
    </Link>
  )
}
