// Test log — one record per attempt, kept on the device, exportable as
// Markdown / CSV to match against the brand's UpPromote referrals later.
import AsyncStorage from '@react-native-async-storage/async-storage'

export interface Attempt {
  id: string
  at: string
  platform: string
  mode: string
  opening: string
  scaRefOnContinue: boolean
  variant: string
  checkoutIdMasked?: string
  status?: string
  authModes?: string
  timings: Record<string, number>
  tokenMatchAfterCookie?: boolean | null
  tokenMatchAfterRef?: boolean | null
  upClickIdSeen?: boolean | null
  prevCartRestored?: boolean | null
  ucpMessages?: string
  fallbackUsed?: string
  /** Mode C: the affiliate time budget ran out. */
  budgetExceeded?: boolean
  paymentUrlMasked?: string
  thankYouSeen?: boolean
  outcome: 'ok' | 'error' | 'stopped' | 'running'
  error?: string
  steps: { label: string; ms?: number; ok?: boolean; detail?: string }[]
  // manual
  prefillWorked?: 'evet' | 'hayır' | '?'
  expressButtons?: string
  notes?: string
}

const KEY = 'kauna.harness.log.v1'

export async function loadLog(): Promise<Attempt[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]') as Attempt[]
  } catch {
    return []
  }
}

export async function saveAttempt(a: Attempt): Promise<Attempt[]> {
  const list = await loadLog()
  const i = list.findIndex((x) => x.id === a.id)
  if (i >= 0) list[i] = a
  else list.unshift(a)
  const trimmed = list.slice(0, 200)
  await AsyncStorage.setItem(KEY, JSON.stringify(trimmed))
  return trimmed
}

export async function clearLog(): Promise<void> {
  await AsyncStorage.removeItem(KEY)
}

const yn = (v: boolean | null | undefined) => (v === true ? 'evet' : v === false ? 'hayır' : '—')

const COLS: [string, (a: Attempt) => string][] = [
  ['Deneme', (a) => a.id],
  ['Tarih', (a) => a.at],
  ['Platform', (a) => a.platform],
  ['Mod', (a) => a.mode],
  ['Açılış', (a) => a.opening],
  ['sca_ref', (a) => (a.scaRefOnContinue ? 'açık' : 'kapalı')],
  ['Varyant', (a) => a.variant],
  ['UCP checkout', (a) => a.checkoutIdMasked ?? '—'],
  ['Durum', (a) => a.status ?? '—'],
  ['Kimlik yolu', (a) => a.authModes ?? '—'],
  ['UCP ms', (a) => String(a.timings.ucpMs ?? '')],
  ['Mağaza bağlantısı ms (/cart.js, UCP ile paralel)', (a) => String(a.timings.warmMs ?? '')],
  ['Ana sayfa ms (yalnızca yedek)', (a) => String(a.timings.homeLoadMs ?? '')],
  ['Ref sayfa ms', (a) => String(a.timings.refLoadMs ?? '')],
  ['_up_click_id ms', (a) => String(a.timings.upClickIdMs ?? '')],
  ['Affiliate ms (UCP sonrası)', (a) => String(a.timings.affiliateMs ?? '')],
  ['Hazırlık ms', (a) => String(a.timings.totalPrepMs ?? '')],
  ['Süre sınırı aşıldı', (a) => yn(a.budgetExceeded)],
  ['Token eşleşti (çerez sonrası)', (a) => yn(a.tokenMatchAfterCookie)],
  ['Token eşleşti (ref sonrası)', (a) => yn(a.tokenMatchAfterRef)],
  ['_up_click_id', (a) => yn(a.upClickIdSeen)],
  ['Önceki sepet geri yüklendi', (a) => yn(a.prevCartRestored)],
  ['UCP mesajları', (a) => a.ucpMessages ?? ''],
  ['Düşülen mod', (a) => a.fallbackUsed ?? ''],
  ['Sonuç', (a) => a.outcome + (a.error ? `: ${a.error}` : '')],
  ['Ön doldurma', (a) => a.prefillWorked ?? '?'],
  ['Hızlı ödeme', (a) => a.expressButtons ?? ''],
  ['Notlar', (a) => a.notes ?? ''],
]

export function toMarkdown(list: Attempt[]): string {
  const esc = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ')
  const head = `| ${COLS.map((c) => c[0]).join(' | ')} |\n| ${COLS.map(() => '---').join(' | ')} |`
  return [
    '## Kauna mobil test günlüğü',
    '',
    head,
    ...list.map((a) => `| ${COLS.map(([, f]) => esc(f(a))).join(' | ')} |`),
  ].join('\n')
}

export function toCsv(list: Attempt[]): string {
  const q = (s: string) => `"${s.replaceAll('"', '""')}"`
  return [COLS.map((c) => q(c[0])).join(','), ...list.map((a) => COLS.map(([, f]) => q(f(a))).join(','))].join('\n')
}
