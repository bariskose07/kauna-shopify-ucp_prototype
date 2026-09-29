// Catalog: global search, seller-scoped search, lookup, get_product.
//
// Rule 3 (Shopify Catalog terms): nothing returned here is stored or cached on
// the server. Responses are normalised for the UI and returned straight to the
// browser; images are rendered from the URLs Shopify gives us.

import { callTool, config, getInputSchema, type CallTrace } from './client'
import { conformToSchema } from './conform'
import { UcpError, isUcpError } from './errors'
import type { UnknownField } from './schema'
import type { Json } from './types'

export interface UiMoney {
  amount: number | null // minor units
  currency: string | null
}

export interface UiVariant {
  id: string
  title: string
  price: UiMoney
  compareAt?: UiMoney
  available: boolean | null
  availabilityStatus?: string
  runningLow?: boolean
  nativeCheckout: boolean | null
  requiresShipping?: boolean
  sellerDomain?: string
  sellerUrl?: string
  sellerName?: string
  options: { name: string; label: string }[]
  url?: string
  checkoutUrl?: string
}

export interface UiProduct {
  id: string
  title: string
  description?: string
  url?: string
  media: { url: string; alt?: string }[]
  options: { name: string; values: { label: string; available?: boolean; exists?: boolean }[] }[]
  selected: { name: string; label: string }[]
  variants: UiVariant[]
  priceMin: UiMoney
  /** Which surface produced this record. */
  source: 'global-catalog' | 'seller-catalog' | 'storefront-products-json'
  /** Business URL to call get_product against for this id. */
  via: string
  handle?: string
}

const US_CONTEXT = { address_country: 'US', currency: 'USD', language: 'en-US' }

function money(m: unknown): UiMoney {
  const o = (m ?? {}) as Json
  return {
    amount: typeof o.amount === 'number' ? o.amount : null,
    currency: typeof o.currency === 'string' ? o.currency : null,
  }
}

function labelOf(v: unknown): string {
  if (typeof v === 'string') return v
  const o = (v ?? {}) as Json
  return String(o.label ?? o.value ?? o.name ?? '')
}

export function normalizeCatalogProduct(p: Json, source: UiProduct['source'], via: string): UiProduct {
  const variants = ((p.variants as Json[]) ?? []).map((v): UiVariant => {
    const availability = (v.availability ?? {}) as Json
    const seller = (v.seller ?? {}) as Json
    const eligible = (v.eligible ?? {}) as Json
    const requires = (v.requires ?? {}) as Json
    const opts = (v.options ?? v.selected_options ?? v.selected ?? []) as unknown[]
    return {
      id: String(v.id),
      title: String(v.title ?? ''),
      price: money(v.price),
      compareAt: v.list_price || v.compare_at_price ? money(v.list_price ?? v.compare_at_price) : undefined,
      available: typeof availability.available === 'boolean' ? availability.available : null,
      availabilityStatus: availability.status as string | undefined,
      runningLow: availability.running_low as boolean | undefined,
      nativeCheckout: typeof eligible.native_checkout === 'boolean' ? eligible.native_checkout : null,
      requiresShipping: requires.shipping as boolean | undefined,
      sellerDomain: seller.domain as string | undefined,
      sellerUrl: seller.url as string | undefined,
      sellerName: seller.name as string | undefined,
      options: Array.isArray(opts)
        ? opts.map((o) => ({ name: String((o as Json).name ?? ''), label: labelOf(o) }))
        : [],
      url: v.url as string | undefined,
      checkoutUrl: v.checkout_url as string | undefined,
    }
  })
  const priceRange = (p.price_range ?? {}) as Json
  const desc = p.description as Json | string | undefined
  return {
    id: String(p.id),
    title: String(p.title ?? ''),
    description: typeof desc === 'string' ? desc : (desc?.plain as string | undefined),
    url: p.url as string | undefined,
    media: ((p.media as Json[]) ?? [])
      .filter((m) => typeof m.url === 'string')
      .map((m) => ({ url: m.url as string, alt: m.alt_text as string | undefined })),
    options: ((p.options as Json[]) ?? []).map((o) => ({
      name: String(o.name ?? ''),
      values: ((o.values as unknown[]) ?? []).map((v) => {
        const vo = (typeof v === 'object' && v !== null ? v : {}) as Json
        return {
          label: labelOf(v),
          available: vo.available as boolean | undefined,
          exists: vo.exists as boolean | undefined,
        }
      }),
    })),
    selected: ((p.selected as Json[]) ?? []).map((s) => ({ name: String(s.name ?? ''), label: labelOf(s) })),
    variants,
    priceMin: money(priceRange.min ?? variants[0]?.price),
    source,
    via,
  }
}

// ─── storefront /products.json fallback (NOT Shopify Catalog) ─────────────────
// Every Shopify storefront publishes /products.json. We use it only as a
// last-resort "seller domain + product name" lookup when the seller's UCP
// endpoint offers no search. Still not cached (same courtesy as rule 3).

interface StorefrontProduct {
  id: number
  title: string
  handle: string
  body_html?: string
  variants: {
    id: number
    title: string
    option1: string | null
    option2: string | null
    option3: string | null
    available: boolean
    price: string
    compare_at_price: string | null
  }[]
  images: { src: string; alt?: string | null }[]
  options: { name: string; position: number; values: string[] }[]
}

function toMinor(price: string | null): number | null {
  if (price === null) return null
  const n = Number.parseFloat(price)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export function normalizeStorefrontProduct(p: StorefrontProduct, seller: string): UiProduct {
  const host = new URL(seller).host
  const variants: UiVariant[] = p.variants.map((v) => ({
    id: `gid://shopify/ProductVariant/${v.id}`,
    title: v.title,
    // products.json carries no currency; the store's presentment currency applies.
    price: { amount: toMinor(v.price), currency: null },
    compareAt: v.compare_at_price ? { amount: toMinor(v.compare_at_price), currency: null } : undefined,
    available: v.available,
    nativeCheckout: null, // unknown outside Catalog
    sellerDomain: host,
    sellerUrl: seller,
    options: p.options
      .map((o, i) => ({ name: o.name, label: [v.option1, v.option2, v.option3][i] ?? '' }))
      .filter((o) => o.label !== ''),
    url: `${seller}/products/${p.handle}?variant=${v.id}`,
  }))
  return {
    id: `gid://shopify/Product/${p.id}`,
    title: p.title,
    description: p.body_html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    url: `${seller}/products/${p.handle}`,
    media: p.images.map((i) => ({ url: i.src, alt: i.alt ?? undefined })),
    options: p.options.map((o) => ({
      name: o.name,
      values: o.values.map((label) => ({
        label,
        available: p.variants.some((v) => v.available && [v.option1, v.option2, v.option3][o.position - 1] === label),
        exists: true,
      })),
    })),
    selected: [],
    variants,
    priceMin: { amount: Math.min(...variants.map((v) => v.price.amount ?? Infinity)), currency: null },
    source: 'storefront-products-json',
    via: seller,
    handle: p.handle,
  }
}

async function storefrontFetch(url: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'kauna-ucp-prototype/0.1' },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    throw new UcpError({ kind: 'network', message: `${url}: ${(e as Error).message}` })
  }
  if (!res.ok) throw new UcpError({ kind: 'http', httpStatus: res.status, message: `${url} → HTTP ${res.status}` })
  return res.json()
}

export async function storefrontSearch(seller: string, query: string): Promise<UiProduct[]> {
  const body = (await storefrontFetch(`${seller}/products.json?limit=250`)) as { products?: StorefrontProduct[] }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return (body.products ?? [])
    .filter((p) => words.every((w) => `${p.title} ${p.handle}`.toLowerCase().includes(w)))
    .slice(0, 30)
    .map((p) => normalizeStorefrontProduct(p, seller))
}

export async function storefrontProduct(seller: string, handle: string): Promise<UiProduct> {
  const body = (await storefrontFetch(`${seller}/products/${encodeURIComponent(handle)}.json`)) as {
    product: StorefrontProduct
  }
  return normalizeStorefrontProduct(body.product, seller)
}

// ─── UCP catalog calls ───────────────────────────────────────────────────────

export interface CatalogResult<T> {
  data: T
  traces: CallTrace[]
  dropped: UnknownField[]
  messages: unknown[]
  notes: string[]
}

async function catalogCall(business: string, tool: string, catalogBody: Json) {
  const schema = await getInputSchema(business, tool)
  const { args, dropped } = conformToSchema(schema, { catalog: catalogBody })
  const res = await callTool<Json>(business, tool, args)
  return { res, dropped }
}

/** Global Catalog search (semantic, cross-merchant), US context. */
export async function searchGlobal(query: string, limit = 20): Promise<CatalogResult<UiProduct[]>> {
  const via = config().catalogUrl
  const { res, dropped } = await catalogCall(via, 'search_catalog', {
    query,
    context: US_CONTEXT,
    pagination: { limit },
  })
  const products = ((res.data.products as Json[]) ?? []).map((p) => normalizeCatalogProduct(p, 'global-catalog', via))
  return { data: products, traces: [res.trace], dropped, messages: (res.data.messages as unknown[]) ?? [], notes: [] }
}

/**
 * "Seller domain + product name": try the seller's own UCP catalog search;
 * if the seller offers none, fall back to global search filtered to that
 * seller, then to the storefront's /products.json.
 */
export async function searchSeller(seller: string, query: string): Promise<CatalogResult<UiProduct[]>> {
  const notes: string[] = []
  const traces: CallTrace[] = []
  try {
    const { res, dropped } = await catalogCall(seller, 'search_catalog', { query, context: US_CONTEXT })
    traces.push(res.trace)
    const products = ((res.data.products as Json[]) ?? []).map((p) => normalizeCatalogProduct(p, 'seller-catalog', seller))
    if (products.length > 0) return { data: products, traces, dropped, messages: (res.data.messages as unknown[]) ?? [], notes }
    notes.push('Satıcının UCP katalog araması boş döndü.')
  } catch (e) {
    notes.push(`Satıcının UCP katalog araması kullanılamadı: ${(e as Error).message}`)
    if (isUcpError(e) && e.details && typeof e.details === 'object' && 'trace' in e.details)
      traces.push((e.details as { trace: CallTrace }).trace)
  }
  try {
    const global = await searchGlobal(`${query}`, 50)
    traces.push(...global.traces)
    const host = new URL(seller).host.replace(/^www\./, '')
    const matches = global.data.filter((p) =>
      p.variants.some((v) =>
        [v.sellerDomain, v.sellerUrl && new URL(v.sellerUrl.startsWith('http') ? v.sellerUrl : `https://${v.sellerUrl}`).host]
          .filter(Boolean)
          .some((d) => String(d).replace(/^www\./, '').endsWith(host) || host.endsWith(String(d).replace(/^www\./, ''))),
      ),
    )
    if (matches.length > 0) {
      notes.push('Global Catalog sonuçları satıcıya göre süzüldü.')
      return { data: matches, traces, dropped: global.dropped, messages: global.messages, notes }
    }
    notes.push('Global Catalog sonuçlarında bu satıcı yok.')
  } catch (e) {
    notes.push(`Global Catalog araması başarısız: ${(e as Error).message}`)
  }
  let sf: UiProduct[]
  try {
    sf = await storefrontSearch(seller, query)
  } catch (e) {
    throw new UcpError({
      kind: isUcpError(e) ? e.kind : 'network',
      message: [...notes, `/products.json da başarısız: ${(e as Error).message}`].join(' · '),
    })
  }
  notes.push('Mağazanın /products.json beslemesi kullanıldı (UCP değil; varyant kimlikleri checkout için geçerli GID olarak çevrildi).')
  return { data: sf, traces, dropped: [], messages: [], notes }
}

/** lookup_catalog: variant/product IDs or product URLs → products. */
export async function lookup(ids: string[], via?: string): Promise<CatalogResult<UiProduct[]>> {
  const business = via ?? config().catalogUrl
  const { res, dropped } = await catalogCall(business, 'lookup_catalog', {
    ids,
    filters: { available: false }, // include OOS so we can tell OOS from delisted
    context: US_CONTEXT,
  })
  const source = business === config().catalogUrl ? 'global-catalog' : 'seller-catalog'
  const products = ((res.data.products as Json[]) ?? []).map((p) => normalizeCatalogProduct(p, source, business))
  return { data: products, traces: [res.trace], dropped, messages: (res.data.messages as unknown[]) ?? [], notes: [] }
}

/** get_product with optional option selection (copy labels verbatim). */
export async function getProduct(
  id: string,
  via: string | undefined,
  selected?: { name: string; label: string }[],
): Promise<CatalogResult<UiProduct | null>> {
  const business = via ?? config().catalogUrl
  const body: Json = { id, context: US_CONTEXT }
  if (selected && selected.length > 0) {
    body.selected = selected
    body.preferences = selected.map((s) => s.name)
  }
  const { res, dropped } = await catalogCall(business, 'get_product', body)
  const p = res.data.product as Json | undefined
  const source = business === config().catalogUrl ? 'global-catalog' : 'seller-catalog'
  return {
    data: p ? normalizeCatalogProduct(p, source, business) : null,
    traces: [res.trace],
    dropped,
    messages: (res.data.messages as unknown[]) ?? [],
    notes: [],
  }
}
