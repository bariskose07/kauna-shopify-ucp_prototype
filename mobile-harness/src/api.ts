// Talks ONLY to the Kauna test server (never to UCP directly; no Shopify
// credentials on the phone — rule 6).
import type { Buyer, Settings } from './config'
import { toGidVariant } from './ids'

export interface UcpSummary {
  attemptId: string
  status: string
  currency?: string
  totals: { type: string; amount: number; display_text?: string }[]
  shipping: { present: boolean; amount?: number; text: string }
  messages: { type: string; code?: string; severity?: string; content?: string }[]
  buyerWarnings: { code?: string; severity?: string; content?: string }[]
  handoff: { required: boolean; reason?: string }
  lineItems: { title?: string; quantity: number; image?: string }[]
  continueUrl?: string
  checkoutIdMasked: string
  cartToken?: string
  cartKey?: string
  auth: { step: string; auth?: { mode: string; label?: string; note?: string } }[]
  phonePlacement: string
  fieldNotes: string[]
  timings: Record<string, number>
}

export async function createUcpCheckout(s: Settings, variantId: string, attemptId: string, buyer: Buyer): Promise<UcpSummary> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 45_000)
  try {
    const res = await fetch(`${s.serverUrl.replace(/\/$/, '')}/api/mobile/ucp-checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seller: s.store, variantId: toGidVariant(variantId), quantity: 1, buyer, attemptId }),
      signal: ctrl.signal,
    })
    const j = await res.json()
    if (!res.ok) {
      const e = j?.error ?? {}
      throw new Error(`${e.kind ?? 'http'}: ${e.message ?? `HTTP ${res.status}`}${e.retryAfterSeconds ? ` (Retry-After ${e.retryAfterSeconds} sn)` : ''}`)
    }
    return j as UcpSummary
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`Sunucu yanıt vermedi (${s.serverUrl})`)
    throw e
  } finally {
    clearTimeout(t)
  }
}

export function formatMoney(amount: number | undefined, currency: string | undefined): string {
  if (amount === undefined || amount === null) return '—'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(amount / 100)
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency ?? ''}`
  }
}
