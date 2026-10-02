// Harness settings (persisted on the device with AsyncStorage — test data only).
import AsyncStorage from '@react-native-async-storage/async-storage'

export type Mode = 'A' | 'B' | 'C' | 'D'
export type Opening = 'inapp' | 'webview' | 'external'
export type FallbackC = 'D' | 'B' | 'stop'
export type CookieStore = 'persistent' | 'incognito'
export type BTarget = 'cart_c' | 'checkout_same_webview'

export interface Buyer {
  email: string
  first_name: string
  last_name: string
  street_address: string
  address_locality: string
  address_region: string
  postal_code: string
  address_country: string
  phone: string
}

export interface Settings {
  mode: Mode
  opening: Opening
  scaRefOnContinue: boolean
  fallbackC: FallbackC
  cookieStore: CookieStore
  bTarget: BTarget
  serverUrl: string
  store: string
  ref: string
  handle: string
  variants: { label: string; id: string }[]
  buyer: Buyer
  upWaitMs: number
  loadTimeoutMs: number
}

export const DEFAULTS: Settings = {
  mode: 'C',
  opening: 'inapp',
  scaRefOnContinue: true,
  fallbackC: 'D',
  cookieStore: 'persistent',
  bTarget: 'cart_c',
  serverUrl: 'http://192.168.1.10:3000',
  store: 'https://us.aabcollection.com',
  ref: '11820123.M7RFlqVRLGp',
  handle: 'cypress-tree-abaya-black-1',
  variants: [
    { label: 'M / 52', id: '47830495691066' },
    { label: 'L / 52', id: '47830495854906' },
  ],
  buyer: {
    email: 'test@example.com',
    first_name: 'Jane',
    last_name: 'Smith',
    street_address: '123 Main Street',
    address_locality: 'Brooklyn',
    address_region: 'NY',
    postal_code: '11201',
    address_country: 'US',
    phone: '+12125550123',
  },
  upWaitMs: 8000,
  loadTimeoutMs: 15000,
}

const KEY = 'kauna.harness.settings.v1'

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const s = JSON.parse(raw) as Partial<Settings>
    return { ...DEFAULTS, ...s, buyer: { ...DEFAULTS.buyer, ...(s.buyer ?? {}) } }
  } catch {
    return DEFAULTS
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(s))
}

export const MODE_LABEL: Record<Mode, string> = {
  A: 'A – Sadece UCP',
  B: 'B – Mağaza sepeti',
  C: 'C – UCP + çerez',
  D: 'D – UCP + sca_ref',
}

export const OPENING_LABEL: Record<Opening, string> = {
  inapp: 'Uygulama içi tarayıcı',
  webview: 'Görünür WebView',
  external: 'Dış tarayıcı',
}
