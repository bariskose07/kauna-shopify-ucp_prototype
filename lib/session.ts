// In-memory session store (rule 6: buyer data lives in process memory only —
// no database, no files). A cookie carries an opaque random id; everything
// else stays in this Map and disappears on restart or after SESSION_TTL_MS.
//
// Catalog results are NOT stored here (rule 3). Only cart/checkout state and
// debug entries for cart/checkout/discovery calls are kept.

import { randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'

import type { BuyerInfo, CommerceObject } from './ucp/types'

export const SESSION_COOKIE = 'kauna_sid'
const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_LOG = 200

export interface DebugEntry {
  id: string
  at: string
  seller?: string
  tool: string
  endpoint?: string
  durationMs?: number
  /** Masked request arguments (wire-faithful except PII). */
  request?: unknown
  /** Masked response, or a placeholder for catalog calls (rule 3). */
  response?: unknown
  error?: unknown
  validation?: unknown
  notes?: string[]
  /** Identity tier used for this request (token / signed / anonymous / cli). */
  auth?: { mode: string; note?: string }
  surface?: string
}

/** Request-shaped line item (what we send back on every full-replace update). */
export interface ReqLineItem {
  id?: string
  item: { id: string }
  quantity: number
}

export interface CartState {
  seller: string
  cartId?: string
  /** False when the business does not offer create_cart → buy-now checkout. */
  cartSupported: boolean
  lineItems: ReqLineItem[]
  /** Display-only snapshot for the cart page (titles/prices from the business). */
  last?: CommerceObject
}

export type PhonePlacement =
  | 'fulfillment.methods[].destinations[].phone_number'
  | 'buyer.phone_number'
  | 'buyer.phone'
  | 'fulfillment.methods[].destinations[].phone'
  | 'none'

export interface CheckoutDraft {
  seller: string
  checkoutId?: string
  draftOrderId: string
  buyer: BuyerInfo
  includePhone: boolean
  phonePlacement: PhonePlacement
  discountCodes: string[]
  /** groupId → optionId chosen by the buyer in Kauna's UI. */
  selectedOptions: Record<string, string>
  /** Scenario tag chosen in the UI (for "Bulguları kopyala"). */
  scenario?: string
  /** Fault injection for scenario 5 (deliberately wrong destination key). */
  injectWrongField: boolean
  last?: CommerceObject
  /** Payload notes from the last build (dropped keys, attribution keys …). */
  buildNotes?: string[]
}

export interface Observation {
  at: string
  scenario?: string
  seller: string
  kind: 'checkout_create' | 'checkout_update' | 'checkout_get' | 'payment_mode' | 'discount' | 'note'
  variantIds?: string[]
  status?: string
  messageCodes?: string[]
  shipping?: string
  discountsApplied?: string[]
  discountCodes?: string[]
  silentFailure?: boolean
  mode?: string
  outcome?: string
  detail?: string
}

export interface Session {
  id: string
  touchedAt: number
  carts: Record<string, CartState>
  checkouts: Record<string, CheckoutDraft>
  buyer?: BuyerInfo
  log: DebugEntry[]
  observations: Observation[]
}

// Survive Next dev HMR by pinning the Map to globalThis.
const g = globalThis as unknown as { __kaunaSessions?: Map<string, Session> }
const sessions: Map<string, Session> = (g.__kaunaSessions ??= new Map())

function sweep(now: number) {
  for (const [id, s] of sessions) if (now - s.touchedAt > SESSION_TTL_MS) sessions.delete(id)
}

/** Get (or create) the caller's session. Only call from route handlers. */
export async function getSession(): Promise<Session> {
  const now = Date.now()
  sweep(now)
  const jar = await cookies()
  let id = jar.get(SESSION_COOKIE)?.value
  let s = id ? sessions.get(id) : undefined
  if (!s) {
    id = randomUUID()
    s = { id, touchedAt: now, carts: {}, checkouts: {}, log: [], observations: [] }
    sessions.set(id, s)
    jar.set(SESSION_COOKIE, id, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS / 1000 })
  }
  s.touchedAt = now
  return s
}

export function pushLog(s: Session, e: Omit<DebugEntry, 'id' | 'at'>): DebugEntry {
  const entry: DebugEntry = { id: randomUUID(), at: new Date().toISOString(), ...e }
  s.log.push(entry)
  if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG)
  return entry
}

export function observe(s: Session, o: Omit<Observation, 'at'>) {
  s.observations.push({ at: new Date().toISOString(), ...o })
  if (s.observations.length > 300) s.observations.splice(0, s.observations.length - 300)
}

/** Canonical https origin for a seller domain / URL input. */
export function normalizeSeller(input: string): string {
  const trimmed = input.trim()
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const u = new URL(withScheme)
  return `https://${u.host.toLowerCase()}`
}

/** Kauna-side draft order number, used as the attribution event id. */
export function newDraftOrderId(): string {
  const d = new Date()
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  return `KAUNA-${ymd}-${randomUUID().slice(0, 8).toUpperCase()}`
}
