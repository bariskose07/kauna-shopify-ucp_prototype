import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { getSession, normalizeSeller, pushLog } from '@/lib/session'
import { getProduct, lookup, storefrontProduct, type UiProduct } from '@/lib/ucp/catalog'
import type { CallTrace } from '@/lib/ucp/client'

export const dynamic = 'force-dynamic'

interface Body {
  id?: string
  via?: string
  selected?: { name: string; label: string }[]
  /** Storefront-sourced product: seller + handle. */
  seller?: string
  handle?: string
}

// PDP: get_product (with option narrowing). For products that came from a
// storefront /products.json, resolve them through Catalog lookup first (so we
// get eligible.native_checkout etc.), falling back to the storefront JSON.
export async function POST(req: Request) {
  const b = (await req.json()) as Body
  const s = await getSession()
  const traces: CallTrace[] = []
  const notes: string[] = []
  const log = () => {
    for (const t of traces)
      pushLog(s, { tool: t.tool, endpoint: t.endpoint, durationMs: t.durationMs, request: t.request, response: '[Catalog yanıtı sunucuda saklanmaz]' })
  }
  try {
    let product: UiProduct | null = null
    let messages: unknown[] = []
    if (b.seller && b.handle) {
      const seller = normalizeSeller(b.seller)
      try {
        const l = await lookup([`${seller}/products/${b.handle}`])
        traces.push(...l.traces)
        const upid = l.data[0]?.id
        if (upid) {
          const p = await getProduct(upid, undefined, b.selected)
          traces.push(...p.traces)
          product = p.data
          messages = p.messages
          notes.push('Mağaza ürünü Global Catalog üzerinden çözüldü (lookup → get_product).')
        }
      } catch (e) {
        notes.push(`Catalog çözümlemesi başarısız: ${(e as Error).message}`)
      }
      if (!product) {
        product = await storefrontProduct(seller, b.handle)
        notes.push('Catalog’da bulunamadı → mağazanın /products/<handle>.json verisi gösteriliyor (native_checkout bilinmiyor).')
      }
    } else if (b.id) {
      const p = await getProduct(b.id, b.via, b.selected)
      traces.push(...p.traces)
      product = p.data
      messages = p.messages
    } else {
      return badRequest('id veya seller+handle gerekli')
    }
    log()
    return NextResponse.json({ product, messages, notes, traces }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    log()
    return errorJson(e, { notes })
  }
}
