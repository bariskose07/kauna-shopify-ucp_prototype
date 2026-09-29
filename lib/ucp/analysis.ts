// Turn a checkout response into what Kauna's summary screen needs, and run
// the "silent failure" checks (rule 4). Pure functions — unit-tested.

import type { CommerceObject, FulfillmentOption, Json, Total, UcpLink, UcpMessage } from './types'

export interface MissingField {
  field: 'phone' | 'email' | 'first_name' | 'last_name' | 'address' | 'unknown'
  code?: string
  content?: string
  path?: string
}

export interface ShippingChoice {
  methodType: string
  groupId: string
  selectedOptionId?: string | null
  options: (FulfillmentOption & { amount?: number; estimate?: string })[]
}

export interface CheckoutAnalysis {
  status: string
  currency?: string
  totals: Total[]
  shipping: { present: boolean; amount?: number; text: string }
  totalsMismatch: boolean
  recoverable: UcpMessage[]
  buyerInput: UcpMessage[]
  buyerReview: UcpMessage[]
  unrecoverable: UcpMessage[]
  warnings: UcpMessage[]
  infos: UcpMessage[]
  missingFields: MissingField[]
  /** Store wants the buyer on its own page (escalation / buyer input / review). */
  handoff: { required: boolean; reason?: string }
  shippingChoices: ShippingChoice[]
  links: UcpLink[]
  discountsApplied: Json[]
  discountCodesEchoed: string[]
  silentFailures: string[]
  completed: boolean
}

const SHIPPING_TYPES = new Set(['fulfillment', 'shipping', 'delivery'])

/** Map a recoverable message to the one field the buyer must supply. */
export function missingFieldFor(m: UcpMessage): MissingField {
  const hay = `${m.code ?? ''} ${m.path ?? ''}`.toLowerCase()
  const field: MissingField['field'] = hay.includes('phone')
    ? 'phone'
    : hay.includes('email')
      ? 'email'
      : hay.includes('first_name')
        ? 'first_name'
        : hay.includes('last_name')
          ? 'last_name'
          : /address|destination|postal|zip|region|locality/.test(hay)
            ? 'address'
            : 'unknown'
  return { field, code: m.code, content: m.content, path: m.path }
}

function estimate(o: FulfillmentOption): string | undefined {
  const a = o.earliest_fulfillment_time
  const b = o.latest_fulfillment_time
  const fmt = (s: string) => {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })
  }
  if (a && b) return `${fmt(a)} – ${fmt(b)}`
  if (a || b) return fmt((a ?? b) as string)
  return typeof o.description === 'string' ? o.description : undefined
}

export interface SentFacts {
  /** A shipping destination was part of the request. */
  addressSent: boolean
  /** Buyer fields we sent (plain values, compared in memory, never logged). */
  buyerSent?: Record<string, string>
  phoneSent?: boolean
}

export function analyzeCheckout(co: CommerceObject, sent: SentFacts): CheckoutAnalysis {
  const messages = co.messages ?? []
  const errors = messages.filter((m) => m.type === 'error')
  const by = (sev: string) => errors.filter((m) => m.severity === sev)
  const totals = co.totals ?? []

  const shipLine = totals.find((t) => SHIPPING_TYPES.has(t.type))
  const shipping = shipLine
    ? { present: true, amount: shipLine.amount, text: '' }
    : // Never show 0 / "free" when the business simply didn't price shipping.
      { present: false, text: 'Kargo ödeme adımında hesaplanır' }

  const total = totals.find((t) => t.type === 'total')
  // Verification only (never used to re-render): non-total lines should sum to
  // the total. items_discount is sometimes already folded into subtotal, so
  // only flag when neither interpretation matches.
  const nonTotal = totals.filter((t) => t.type !== 'total')
  const sum = nonTotal.reduce((a, t) => a + (t.amount ?? 0), 0)
  const sumNoItemsDiscount = nonTotal
    .filter((t) => t.type !== 'items_discount')
    .reduce((a, t) => a + (t.amount ?? 0), 0)
  const totalsMismatch = total !== undefined && sum !== total.amount && sumNoItemsDiscount !== total.amount

  const recoverable = by('recoverable')
  const buyerInput = by('requires_buyer_input')
  const buyerReview = by('requires_buyer_review')
  const unrecoverable = by('unrecoverable')

  const status = co.status ?? 'unknown'
  const escalationCodes = errors.filter((m) => m.code === 'extension_interaction_required')
  const handoffRequired =
    status === 'requires_escalation' || buyerInput.length > 0 || buyerReview.length > 0 || escalationCodes.length > 0
  const handoff = handoffRequired
    ? {
        required: true,
        reason:
          [...buyerInput, ...buyerReview, ...escalationCodes].map((m) => m.code ?? m.content).filter(Boolean)[0] ??
          status,
      }
    : { required: false }

  const methods = co.fulfillment?.methods ?? []
  const shippingChoices: ShippingChoice[] = methods.flatMap((m) =>
    (m.groups ?? []).map((g) => ({
      methodType: m.type,
      groupId: g.id,
      selectedOptionId: g.selected_option_id,
      options: (g.options ?? []).map((o) => ({
        ...o,
        amount: (o.totals ?? []).find((t) => t.type === 'total')?.amount ?? o.totals?.[0]?.amount,
        estimate: estimate(o),
      })),
    })),
  )

  // ── silent-failure checks ──────────────────────────────────────────────
  const silentFailures: string[] = []
  if (sent.addressSent) {
    const anyDest = methods.some((m) => (m.destinations ?? []).length > 0)
    const anyOptions = shippingChoices.some((c) => c.options.length > 0)
    if (methods.length === 0) {
      silentFailures.push(
        'Adres gönderildi ama fulfillment.methods boş döndü — adres işlenmemiş olabilir, alanları şemaya göre kontrol et.',
      )
    } else if (!anyDest) {
      silentFailures.push('Adres gönderildi ama yanıtta hiçbir teslimat adresi (destinations) yok — adres yok sayılmış olabilir.')
    } else if (!anyOptions && !shipping.present && recoverable.length === 0) {
      silentFailures.push('Adres kabul edilmiş görünüyor ama kargo seçeneği/ücreti dönmedi.')
    }
  }
  if (sent.buyerSent && co.buyer) {
    for (const [k, v] of Object.entries(sent.buyerSent)) {
      if (v && co.buyer[k] === undefined) silentFailures.push(`buyer.${k} gönderildi ama yanıtta yok — alan adı yanlış olabilir.`)
    }
  }
  if (
    sent.phoneSent &&
    recoverable.some((m) => (m.code ?? '').includes('phone'))
  ) {
    silentFailures.push('Telefon gönderildi ama mağaza hâlâ telefon istiyor — telefon yanlış alana yazılmış olabilir.')
  }

  const discounts = co.discounts ?? {}
  return {
    status,
    currency: co.currency,
    totals,
    shipping,
    totalsMismatch,
    recoverable,
    buyerInput,
    buyerReview,
    unrecoverable,
    warnings: messages.filter((m) => m.type === 'warning'),
    infos: messages.filter((m) => m.type === 'info'),
    missingFields: recoverable.map(missingFieldFor),
    handoff,
    shippingChoices,
    links: co.links ?? [],
    discountsApplied: (discounts.applied as Json[]) ?? [],
    discountCodesEchoed: (discounts.codes as string[]) ?? (co.discount_codes as string[] | undefined) ?? [],
    silentFailures,
    completed: status === 'completed' || Boolean(co.order),
  }
}
