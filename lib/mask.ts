// PII masking for the debug panel / logs. Card data is never collected at all
// (rule 2), so this only has to cover buyer identity + address.

const PII_KEYS =
  /^(email|phone|phone_number|telephone|first_name|last_name|full_name|street_address|address_line[12]?|address1|address2|extended_address|postal_code|zip|access_token|client_secret|authorization|dev\.ucp\.buyer_ip|buyer_ip)$/i

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE = /\+?\d[\d\s().-]{7,}\d/g

function maskString(s: string): string {
  if (s.length <= 2) return '**'
  return `${s.slice(0, 1)}***${s.slice(-1)}`
}

/** Deep-copy `value` with PII masked. Safe for anything JSON-shaped. */
export function maskPII<T>(value: T, parentKey = ''): T {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (PII_KEYS.test(parentKey)) return maskString(value) as T
    // Free-text fields (message content, URLs) can still carry an email.
    return value.replace(EMAIL, '<email>') as T
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((v) => maskPII(v, parentKey)) as T
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PII_KEYS.test(k) && typeof v === 'string' ? maskString(v) : maskPII(v, k)
    }
    return out as T
  }
  return value
}

/** For plain log lines. */
export function maskText(s: string): string {
  return s.replace(EMAIL, '<email>').replace(PHONE, '<phone>')
}
