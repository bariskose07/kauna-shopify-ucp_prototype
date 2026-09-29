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

export function ProductCard({ p }: { p: UiProduct }) {
  const v = p.variants[0]
  const img = p.media[0]
  return (
    <Link href={productHref(p)} className="product-card">
      {/* Image straight from Shopify's CDN URL — never proxied or cached by us. */}
      {img ? <img src={img.url} alt={img.alt ?? p.title} loading="lazy" /> : <div style={{ aspectRatio: '3/4' }} />}
      <div className="body">
        <div className="title">{p.title}</div>
        <div>
          {formatMoney(p.priceMin.amount, p.priceMin.currency)}{' '}
          <span className="muted small">{p.priceMin.currency ?? ''}</span>
        </div>
        <div className="muted small mono">{v?.sellerDomain ?? '—'}</div>
        <div className="row small" style={{ marginTop: 4 }}>
          {v?.nativeCheckout === false && <span className="badge warn">native_checkout: false</span>}
          {v?.nativeCheckout === true && <span className="badge ok">native_checkout</span>}
          {p.source === 'storefront-products-json' && <span className="badge">products.json</span>}
        </div>
      </div>
    </Link>
  )
}
