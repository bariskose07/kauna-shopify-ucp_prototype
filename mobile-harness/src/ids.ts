// Variant id conversions + masking of sensitive cart values.

/** gid://shopify/ProductVariant/123 or "123" → "123" (for /cart/add.js). */
export function toNumericVariant(id: string): string {
  const m = /(\d+)\s*$/.exec(id.split('?')[0])
  if (!m) throw new Error(`Geçersiz varyant kimliği: ${id}`)
  return m[1]
}

/** "123" → gid://shopify/ProductVariant/123 (UCP). */
export function toGidVariant(id: string): string {
  return id.startsWith('gid://') ? id : `gid://shopify/ProductVariant/${toNumericVariant(id)}`
}

/** Rule 5: cart keys / tokens are shown and logged as the first 6 chars only. */
export function mask6(v: string | null | undefined): string {
  if (!v) return '—'
  return v.length <= 6 ? '******' : `${v.slice(0, 6)}…`
}

/** Mask the token and key inside a /cart/c/{token}?key={key} style URL. */
export function maskUrl(url: string): string {
  return url
    .replace(/(\/cart\/c\/)([^?&#]+)/, (_, p, t) => `${p}${mask6(t)}`)
    .replace(/([?&]key=)([^&#]+)/g, (_, p, k) => `${p}${mask6(k)}`)
    .replace(/(checkout%5B[^=]+%5D=|checkout\[[^=]+\]=)([^&]+)/g, (_, p) => `${p}***`)
}

export function appendParam(url: string, key: string, value: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}

export function newAttemptId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `KAUNA-ATT-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rnd}`
}

/** React Native's URL polyfill lacks .host/.pathname on some versions — parse by hand. */
export function hostPath(url: string): { host: string; path: string } {
  const m = /^[a-z]+:\/\/([^/?#]+)([^?#]*)/i.exec(url)
  return { host: m?.[1] ?? '', path: m?.[2] || '/' }
}
