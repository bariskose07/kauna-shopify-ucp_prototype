'use client'
// Browser-side helpers. The browser only talks to OUR /api routes — never to
// UCP endpoints directly.

export interface ApiError {
  kind: string
  message: string
  hint?: string
  rpcCode?: number
  httpStatus?: number
  retryAfterSeconds?: number
  data?: unknown
  validation?: unknown
}

export class ApiFailure extends Error {
  error: ApiError
  body: Record<string, unknown>
  constructor(error: ApiError, body: Record<string, unknown>) {
    super(error.message)
    this.error = error
    this.body = body
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const err = (body.error as ApiError) ?? { kind: 'http', message: `HTTP ${res.status}` }
    // Catalog traces from failed calls still belong in the client log.
    if (body.trace) pushClientLog({ tool: 'error', payload: body.trace })
    throw new ApiFailure(err, body)
  }
  return body as T
}

// ── money ────────────────────────────────────────────────────────────────
export function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return '—'
  if (!currency) return `${(amount / 100).toFixed(2)} (mağaza para birimi)`
  try {
    const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency })
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2
    return fmt.format(amount / 10 ** digits)
  } catch {
    return `${amount} ${currency}`
  }
}

// ── client-side debug log (catalog traces live only here — rule 3) ─────────
export interface ClientLogEntry {
  at: string
  tool: string
  payload: unknown
}
const clientLog: ClientLogEntry[] = []
const listeners = new Set<() => void>()

export function pushClientLog(e: Omit<ClientLogEntry, 'at'>) {
  clientLog.push({ at: new Date().toISOString(), ...e })
  if (clientLog.length > 100) clientLog.splice(0, clientLog.length - 100)
  for (const l of listeners) l()
}
export function getClientLog() {
  return clientLog
}
export function subscribeClientLog(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ── settings (per-viewer convenience only) ──────────────────────────────────
export type PaymentMode = 'A' | 'B' | 'C'
export function getPaymentMode(): PaymentMode {
  try {
    const v = localStorage.getItem('kauna.paymentMode')
    return v === 'A' || v === 'C' ? v : 'B'
  } catch {
    return 'B'
  }
}
export function setPaymentMode(m: PaymentMode) {
  try {
    localStorage.setItem('kauna.paymentMode', m)
  } catch {
    /* private mode — fine */
  }
}

export async function reportEvent(e: { seller?: string; scenario?: string; mode?: string; outcome?: string; detail?: string; event?: unknown }) {
  pushClientLog({ tool: `payment:${e.mode}:${e.outcome ?? 'event'}`, payload: e })
  try {
    await fetch('/api/debug/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(e) })
  } catch {
    /* best effort */
  }
}

/** "us.aabcollection.com" / "https://us.aabcollection.com/x" → "https://us.aabcollection.com" */
export function sellerOrigin(input: string): string {
  const s = input.trim()
  if (!s) return ''
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).origin
  } catch {
    return ''
  }
}
