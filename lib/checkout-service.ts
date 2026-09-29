// Checkout orchestration used by the route handlers. Keeps the whole draft in
// the in-memory session so every update can be sent as a full payload.
// There is no complete step here or anywhere else (rule 1).

import { logged } from './api'
import { maskPII } from './mask'
import { newDraftOrderId, normalizeSeller, observe, type CartState, type CheckoutDraft, type Session } from './session'
import { analyzeCheckout, type CheckoutAnalysis, type SentFacts } from './ucp/analysis'
import { extractObject } from './ucp/cart'
import { buildCheckoutBody, schemaFacts, withUtm, type SchemaFacts } from './ucp/checkout'
import { callTool, getInputSchema, type CallTrace } from './ucp/client'
import { UcpError } from './ucp/errors'
import type { BuyerInfo, CommerceObject, Json } from './ucp/types'

export interface CheckoutView {
  seller: string
  checkoutId?: string
  draftOrderId: string
  checkout?: CommerceObject
  analysis?: CheckoutAnalysis
  continueUrl?: string
  rawContinueUrl?: string
  ucp?: { version?: unknown; capabilities?: unknown; payment_handlers?: unknown }
  phonePlacement: string
  phoneCandidates?: Record<string, string>
  includePhone: boolean
  discountCodes: string[]
  scenario?: string
  buildNotes: string[]
  traces: CallTrace[]
}

async function factsFor(seller: string) {
  const [createSchema, updateSchema] = await Promise.all([
    getInputSchema(seller, 'create_checkout'),
    getInputSchema(seller, 'update_checkout'),
  ])
  return { cf: schemaFacts(createSchema, 'create'), uf: schemaFacts(updateSchema, 'update') }
}

function sentFacts(draft: CheckoutDraft, uf: SchemaFacts, body: Json): SentFacts {
  const buyer = (body.buyer ?? {}) as Record<string, string>
  const plain: Record<string, string> = {}
  for (const k of ['email', 'first_name', 'last_name']) if (buyer[k]) plain[k] = buyer[k]
  return {
    addressSent: Boolean(body.fulfillment),
    buyerSent: plain,
    phoneSent: draft.includePhone && uf.phonePlacement !== 'none',
  }
}

function view(draft: CheckoutDraft, traces: CallTrace[], analysis?: CheckoutAnalysis, uf?: SchemaFacts): CheckoutView {
  const co = draft.last
  return {
    seller: draft.seller,
    checkoutId: draft.checkoutId,
    draftOrderId: draft.draftOrderId,
    checkout: co,
    analysis,
    continueUrl: withUtm(co?.continue_url, draft.draftOrderId),
    rawContinueUrl: co?.continue_url,
    ucp: co?.ucp ? { version: co.ucp.version, capabilities: co.ucp.capabilities, payment_handlers: co.ucp.payment_handlers } : undefined,
    phonePlacement: draft.phonePlacement,
    phoneCandidates: uf?.phoneCandidates,
    includePhone: draft.includePhone,
    discountCodes: draft.discountCodes,
    scenario: draft.scenario,
    buildNotes: draft.buildNotes ?? [],
    traces,
  }
}

function record(s: Session, draft: CheckoutDraft, kind: 'checkout_create' | 'checkout_update' | 'checkout_get' | 'discount', a: CheckoutAnalysis, detail?: string) {
  observe(s, {
    scenario: draft.scenario,
    seller: draft.seller,
    kind,
    variantIds: (draft.last?.line_items ?? []).map((li) => li.item.id),
    status: a.status,
    messageCodes: [...a.recoverable, ...a.buyerInput, ...a.buyerReview, ...a.unrecoverable, ...a.warnings].map(
      (m) => `${m.code ?? '?'}${m.severity ? ` (${m.severity})` : ''}`,
    ),
    shipping: a.shipping.present ? `${a.shipping.amount} ${a.currency ?? ''}`.trim() : a.shipping.text,
    discountCodes: draft.discountCodes,
    discountsApplied: a.discountsApplied.map((d) => `${String(d.code ?? d.title ?? '?')}: ${String(d.amount ?? '')}`),
    silentFailure: a.silentFailures.length > 0,
    detail,
  })
}

export interface CreateInput {
  seller: string
  buyer: BuyerInfo
  includePhone: boolean
  discountCodes: string[]
  scenario?: string
  injectWrongField?: boolean
  /**
   * Reuse the open checkout for this seller when its lines still match the
   * cart (one update instead of create + update — Checkout MCP limits are
   * tight). The checkout page's "Yeni checkout" passes false.
   */
  reuse?: boolean
}

const TERMINAL = new Set(['completed', 'canceled', 'cancelled', 'expired'])

function sameLines(cart: CartState, co: CommerceObject | undefined): boolean {
  const key = (id: string, q: number) => `${id}×${q}`
  const a = cart.lineItems.map((l) => key(l.item.id, l.quantity)).sort()
  const b = (co?.line_items ?? []).map((l) => key(l.item.id, l.quantity)).sort()
  return a.length > 0 && a.join('|') === b.join('|')
}

export async function createCheckoutFlow(s: Session, input: CreateInput): Promise<CheckoutView> {
  const seller = normalizeSeller(input.seller)
  const cart = s.carts[seller]
  if (!cart || cart.lineItems.length === 0) {
    throw new UcpError({ kind: 'schema', message: `Sepette ${seller} satıcısından ürün yok.` })
  }
  const existing = s.checkouts[seller]
  if (
    input.reuse &&
    existing?.checkoutId &&
    existing.last &&
    !TERMINAL.has(existing.last.status ?? '') &&
    sameLines(cart, existing.last)
  ) {
    try {
      return await updateCheckoutFlow(s, seller, {
        buyer: input.buyer,
        includePhone: input.includePhone,
        discountCodes: input.discountCodes.length ? input.discountCodes : existing.discountCodes,
      })
    } catch {
      // Expired / unknown id → fall through and create a fresh one.
    }
  }
  const { cf, uf } = await factsFor(seller)
  const draft: CheckoutDraft = {
    seller,
    draftOrderId: newDraftOrderId(),
    buyer: input.buyer,
    includePhone: input.includePhone,
    phonePlacement: uf.phonePlacement,
    discountCodes: input.discountCodes,
    selectedOptions: {},
    scenario: input.scenario,
    injectWrongField: Boolean(input.injectWrongField),
  }
  s.buyer = input.buyer
  s.checkouts[seller] = draft
  const traces: CallTrace[] = []

  // Step 1 — create with line items / cart, buyer, discounts, attribution.
  // The destination goes in step 2 because line_item_ids only exist after create.
  let c1 = buildCheckoutBody({ draft, facts: cf, cart, includeFulfillment: false })
  let r1
  try {
    r1 = await logged(s, seller, () => callTool<Json>(seller, 'create_checkout', { checkout: c1.body }))
  } catch (e) {
    // An expired/unknown cart_id: retry once as buy-now with explicit lines.
    if (!('cart_id' in c1.body) || !(e instanceof UcpError) || e.kind !== 'jsonrpc') throw e
    c1 = buildCheckoutBody({ draft, facts: cf, cart: { ...cart, cartId: undefined }, includeFulfillment: false })
    c1.notes.push('cart_id reddedildi → checkout satırlarla (line_items) oluşturuldu.')
    r1 = await logged(s, seller, () => callTool<Json>(seller, 'create_checkout', { checkout: c1.body }))
  }
  traces.push(r1.trace)
  let co = extractObject(r1.data, 'checkout')
  draft.checkoutId = co.id
  draft.last = co
  draft.buildNotes = c1.notes

  // Step 2 — full update including the shipping destination.
  const u = buildCheckoutBody({ draft, facts: uf, last: co, includeFulfillment: true })
  draft.buildNotes = [...new Set([...c1.notes, ...u.notes])]
  try {
    const r2 = await logged(s, seller, () =>
      callTool<Json>(seller, 'update_checkout', { id: co.id, checkout: u.body }, { allowUnknownFields: u.faultInjected }),
    )
    traces.push(r2.trace)
    co = extractObject(r2.data, 'checkout')
    draft.last = co
  } catch (e) {
    // Keep the created checkout visible even if the address step failed.
    if (e instanceof UcpError) e.details = { ...(e.details as Json), view: view(draft, traces) }
    throw e
  }
  const a = analyzeCheckout(co, sentFacts(draft, uf, u.body))
  record(s, draft, 'checkout_create', a, u.faultInjected ? 'fault-injected wrong field' : undefined)
  return view(draft, traces, a, uf)
}

export interface UpdatePatch {
  includePhone?: boolean
  buyer?: Partial<BuyerInfo>
  discountCodes?: string[]
  selectOption?: { groupId: string; optionId: string }
  scenario?: string
  injectWrongField?: boolean
}

export async function updateCheckoutFlow(s: Session, sellerInput: string, patch: UpdatePatch): Promise<CheckoutView> {
  const seller = normalizeSeller(sellerInput)
  const draft = s.checkouts[seller]
  if (!draft?.checkoutId || !draft.last) throw new UcpError({ kind: 'schema', message: 'Önce checkout oluşturun.' })
  if (patch.buyer) draft.buyer = { ...draft.buyer, ...patch.buyer }
  if (patch.includePhone !== undefined) draft.includePhone = patch.includePhone
  if (patch.discountCodes) draft.discountCodes = patch.discountCodes.map((c) => c.trim()).filter(Boolean)
  if (patch.selectOption) draft.selectedOptions[patch.selectOption.groupId] = patch.selectOption.optionId
  if (patch.scenario !== undefined) draft.scenario = patch.scenario
  if (patch.injectWrongField !== undefined) draft.injectWrongField = patch.injectWrongField
  s.buyer = draft.buyer

  const { uf } = await factsFor(seller)
  draft.phonePlacement = uf.phonePlacement
  const u = buildCheckoutBody({ draft, facts: uf, last: draft.last, includeFulfillment: true })
  draft.buildNotes = u.notes
  const r = await logged(s, seller, () =>
    callTool<Json>(seller, 'update_checkout', { id: draft.checkoutId, checkout: u.body }, { allowUnknownFields: u.faultInjected }),
  )
  const co = extractObject(r.data, 'checkout')
  draft.last = co
  const a = analyzeCheckout(co, sentFacts(draft, uf, u.body))
  record(s, draft, patch.discountCodes ? 'discount' : 'checkout_update', a)
  return view(draft, [r.trace], a, uf)
}

export async function getCheckoutFlow(s: Session, sellerInput: string): Promise<CheckoutView> {
  const seller = normalizeSeller(sellerInput)
  const draft = s.checkouts[seller]
  if (!draft?.checkoutId) throw new UcpError({ kind: 'schema', message: 'Bu satıcı için checkout yok.' })
  const r = await logged(s, seller, () => callTool<Json>(seller, 'get_checkout', { id: draft.checkoutId }))
  const co = extractObject(r.data, 'checkout')
  draft.last = co
  const a = analyzeCheckout(co, { addressSent: false })
  record(s, draft, 'checkout_get', a)
  return view(draft, [r.trace], a)
}

/** Snapshot of all checkouts for the debug panel (PII masked). */
export function checkoutsSnapshot(s: Session) {
  return Object.values(s.checkouts).map((d) => ({
    seller: d.seller,
    checkoutId: d.checkoutId,
    draftOrderId: d.draftOrderId,
    status: d.last?.status,
    messages: d.last?.messages ?? [],
    continueUrl: d.last?.continue_url,
    ucp: maskPII(d.last?.ucp),
    phonePlacement: d.phonePlacement,
    scenario: d.scenario,
    buildNotes: d.buildNotes,
  }))
}
