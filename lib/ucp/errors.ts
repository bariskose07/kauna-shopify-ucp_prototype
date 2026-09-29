// Two failure families, kept strictly apart (see README "Hata ayrımı"):
//
//  1. Protocol / transport failures → thrown as UcpError. These come back as a
//     JSON-RPC `error` object (-32000, -32001, -32602 …), an HTTP status
//     (401/403/429/5xx) or a network failure. Nothing about the checkout
//     changed; the request itself failed.
//  2. Business outcomes (out of stock, missing phone, escalation) → NOT errors.
//     They arrive inside a successful `result` as `messages[]` with a
//     `severity`, and are handled by analysis.ts.

export type UcpErrorKind =
  | 'jsonrpc' // JSON-RPC error envelope from the business
  | 'http' // non-2xx without a JSON-RPC envelope
  | 'rate_limited' // HTTP 429 (Retry-After honoured once, then surfaced)
  | 'network' // DNS / TLS / timeout / connection refused
  | 'discovery' // /.well-known/ucp missing or unusable
  | 'not_offered' // business does not expose the tool
  | 'schema' // our own pre-flight: payload does not match the live inputSchema
  | 'forbidden' // prototype safety rail (e.g. complete_checkout)
  | 'auth' // token exchange failed
  | 'cli' // CLI adapter failure

export class UcpError extends Error {
  kind: UcpErrorKind
  rpcCode?: number
  httpStatus?: number
  retryAfterSeconds?: number
  data?: unknown
  details?: unknown

  constructor(opts: {
    kind: UcpErrorKind
    message: string
    rpcCode?: number
    httpStatus?: number
    retryAfterSeconds?: number
    data?: unknown
    details?: unknown
  }) {
    super(opts.message)
    this.name = 'UcpError'
    this.kind = opts.kind
    this.rpcCode = opts.rpcCode
    this.httpStatus = opts.httpStatus
    this.retryAfterSeconds = opts.retryAfterSeconds
    this.data = opts.data
    this.details = opts.details
  }

  toJSON() {
    return {
      kind: this.kind,
      message: this.message,
      rpcCode: this.rpcCode,
      httpStatus: this.httpStatus,
      retryAfterSeconds: this.retryAfterSeconds,
      data: this.data,
      details: this.details,
    }
  }
}

export function isUcpError(e: unknown): e is UcpError {
  return e instanceof UcpError
}

/** Parse Retry-After (delta-seconds or HTTP-date) into seconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const n = Number(value)
  if (Number.isFinite(n)) return Math.max(0, n)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, Math.ceil((date - now) / 1000))
}
