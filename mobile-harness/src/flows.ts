// The four payment modes. Everything that touches the store page runs in the
// user's own WebView, started by the user's tap (spec rule 4).
import * as WebBrowser from 'expo-web-browser'
import { Linking, Platform } from 'react-native'

import { createUcpCheckout, type UcpSummary } from './api'
import type { BrowserHandle } from './Browser'
import type { Mode, Settings } from './config'
import { MODE_LABEL, OPENING_LABEL } from './config'
import { appendParam, mask6, maskUrl, toNumericVariant } from './ids'
import { JS } from './injected'
import type { Attempt } from './log'

export interface Step {
  label: string
  state: 'run' | 'ok' | 'fail' | 'skip'
  ms?: number
  detail?: string
}

export interface Prepared {
  attempt: Attempt
  summary?: UcpSummary
  /** URL to open (unmasked — never logged; the log keeps a masked copy). */
  paymentUrl?: string
  /** Mode B "/checkout in the same WebView": must open in our Browser. */
  forceBrowser?: boolean
  affiliateNote: string
}

interface Ctx {
  s: Settings
  variantId: string
  attemptId: string
  browser: BrowserHandle
  onSteps: (steps: Step[]) => void
  onSummary: (s: UcpSummary) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type CartInfo = { token: string | null; hasUp: boolean; upHead: string | null; items: number }

function prefillQuery(s: Settings): string {
  const b = s.buyer
  const pairs: [string, string][] = [
    ['checkout[email]', b.email],
    ['checkout[shipping_address][first_name]', b.first_name],
    ['checkout[shipping_address][last_name]', b.last_name],
    ['checkout[shipping_address][address1]', b.street_address],
    ['checkout[shipping_address][city]', b.address_locality],
    ['checkout[shipping_address][province]', b.address_region],
    ['checkout[shipping_address][zip]', b.postal_code],
    ['checkout[shipping_address][country]', b.address_country],
    ['checkout[shipping_address][phone]', b.phone],
  ]
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

export async function prepare(ctx: Ctx): Promise<Prepared> {
  const { s, browser } = ctx
  const started = Date.now()
  const steps: Step[] = []
  const attempt: Attempt = {
    id: ctx.attemptId,
    at: new Date().toISOString(),
    platform: `${Platform.OS} ${String(Platform.Version)}`,
    mode: MODE_LABEL[s.mode],
    opening: OPENING_LABEL[s.opening],
    scaRefOnContinue: s.scaRefOnContinue,
    variant: ctx.variantId,
    timings: {},
    outcome: 'running',
    steps: [],
  }
  const push = (label: string): Step => {
    const st: Step = { label, state: 'run' }
    steps.push(st)
    ctx.onSteps([...steps])
    return st
  }
  const done = (st: Step, ok: boolean, detail?: string, t0?: number) => {
    st.state = ok ? 'ok' : 'fail'
    st.detail = detail
    if (t0) st.ms = Date.now() - t0
    attempt.steps.push({ label: st.label, ok, ms: st.ms, detail })
    ctx.onSteps([...steps])
  }

  // ── shared steps ───────────────────────────────────────────────────────
  const ucp = async (infoOnly = false): Promise<UcpSummary | undefined> => {
    const st = push(infoOnly ? 'UCP özeti (bilgi için)' : 'UCP checkout oluşturuluyor…')
    const t0 = Date.now()
    try {
      const sum = await createUcpCheckout(s, ctx.variantId, ctx.attemptId, s.buyer)
      attempt.timings.ucpMs = Date.now() - t0
      attempt.checkoutIdMasked = sum.checkoutIdMasked
      attempt.status = sum.status
      attempt.authModes = sum.auth.map((a) => `${a.step}:${a.auth?.mode ?? '?'}`).join(', ')
      attempt.ucpMessages = sum.messages.map((m) => `${m.code ?? '?'}${m.severity ? `(${m.severity})` : ''}`).join(', ')
      ctx.onSummary(sum)
      done(st, true, `${sum.status} · ${attempt.authModes}`, t0)
      return sum
    } catch (e) {
      done(st, false, (e as Error).message, t0)
      if (infoOnly) return undefined
      throw e
    }
  }

  const pollUp = async (expectToken?: string): Promise<{ seen: boolean; info?: CartInfo; ms: number }> => {
    const t0 = Date.now()
    let info: CartInfo | undefined
    while (Date.now() - t0 < s.upWaitMs) {
      info = await browser.run<CartInfo>(JS.cartInfo)
      const tokenOk = expectToken ? Boolean(info.token?.startsWith(expectToken)) : true
      if (expectToken) attempt.tokenMatchAfterRef = tokenOk
      if (info.hasUp && tokenOk) return { seen: true, info, ms: Date.now() - t0 }
      await sleep(500)
    }
    return { seen: false, info, ms: Date.now() - t0 }
  }

  // ── Mode B: store cart (UCP only informative) ─────────────────────────
  const modeB = async (fromFallback: boolean): Promise<Prepared> => {
    if (!fromFallback) await ucp(true)
    if (!fromFallback) browser.reset()
    let st = push('Ref’li ürün sayfası yükleniyor…')
    let t0 = Date.now()
    attempt.timings.refLoadMs = await browser.load(`${s.store}/products/${s.handle}?sca_ref=${encodeURIComponent(s.ref)}`, s.loadTimeoutMs)
    done(st, true, undefined, t0)

    st = push('Affiliate kimliği bekleniyor (_up_click_id)…')
    const up = await pollUp()
    attempt.upClickIdSeen = up.seen
    attempt.timings.upClickIdMs = up.ms
    done(st, up.seen, up.seen ? `görüldü (${up.info?.upHead}…)` : `${s.upWaitMs / 1000} sn içinde gelmedi`)
    if (!up.seen) throw new Error('Affiliate kimliği (_up_click_id) mağaza sepetine yazılmadı')

    st = push('Ürün mağaza sepetine ekleniyor (/cart/add.js)…')
    t0 = Date.now()
    await browser.run(JS.addToCart(toNumericVariant(ctx.variantId), 1))
    done(st, true, undefined, t0)

    st = push('Sepet kimliği alınıyor (/cart.js)…')
    const info = await browser.run<CartInfo>(JS.cartInfo)
    if (!info.token) throw new Error('/cart.js token döndürmedi')
    done(st, true, `token ${mask6(info.token)} · _up_click_id ${info.hasUp ? 'var' : 'yok'}`)

    const q = prefillQuery(s)
    if (s.bTarget === 'checkout_same_webview') {
      return {
        attempt,
        paymentUrl: `${s.store}/checkout?${q}`,
        forceBrowser: true,
        affiliateNote: 'Mağaza sepeti: _up_click_id sepette (UpPromote kodu yazdı). Ön doldurma adres çubuğunda kişisel bilgi taşır.',
      }
    }
    // token is "xxx?key=yyy" → /cart/c/xxx?key=yyy&checkout[...]
    const base = `${s.store}/cart/c/${info.token}`
    return {
      attempt,
      paymentUrl: `${base}${base.includes('?') ? '&' : '?'}${q}`,
      affiliateNote: 'Mağaza sepeti: _up_click_id sepette (UpPromote kodu yazdı). Ön doldurma adres çubuğunda kişisel bilgi taşır.',
    }
  }

  const withRef = (url: string) => (s.scaRefOnContinue ? appendParam(url, 'sca_ref', s.ref) : url)

  try {
    let result: Prepared
    const mode: Mode = s.mode
    if (mode === 'A') {
      const sum = await ucp()
      result = { attempt, summary: sum, paymentUrl: sum?.continueUrl, affiliateNote: 'Bu modda affiliate takibi yok.' }
    } else if (mode === 'D') {
      const sum = await ucp()
      result = {
        attempt,
        summary: sum,
        paymentUrl: sum?.continueUrl ? appendParam(sum.continueUrl, 'sca_ref', s.ref) : undefined,
        affiliateNote: 'O anki sipariş için affiliate takibi belirsiz (piksele bağlı).',
      }
    } else if (mode === 'B') {
      result = await modeB(false)
    } else {
      // ── Mode C: UCP cart + UpPromote writes _up_click_id into it ───────
      const sum = (await ucp()) as UcpSummary
      if (!sum.cartToken || !sum.cartKey) throw new Error('Sunucu cartToken/cartKey döndürmedi (checkout id biçimi farklı)')
      browser.reset()
      let prev: string | null = null
      let cookieSet = false
      let seen = false
      try {
        let st = push('Mağaza ana sayfası yükleniyor…')
        let t0 = Date.now()
        attempt.timings.homeLoadMs = await browser.load(`${s.store}/`, s.loadTimeoutMs)
        done(st, true, undefined, t0)

        st = push('Sepet bağlanıyor (cart çerezi → UCP sepeti)…')
        prev = await browser.run<string | null>(JS.readCartCookie)
        cookieSet = await browser.run<boolean>(JS.setCartCookie(sum.cartToken, sum.cartKey))
        const info = await browser.run<CartInfo>(JS.cartInfo)
        attempt.tokenMatchAfterCookie = Boolean(info.token?.startsWith(sum.cartToken))
        done(
          st,
          attempt.tokenMatchAfterCookie,
          `önceki sepet: ${prev ? mask6(prev) : 'yok'} · /cart.js token ${mask6(info.token)} ${attempt.tokenMatchAfterCookie ? '= UCP' : '≠ UCP'}`,
        )
        if (!attempt.tokenMatchAfterCookie) throw new Error('cart çerezi UCP sepetine bağlanamadı (/cart.js token farklı)')

        st = push('Ref’li ürün sayfası yükleniyor…')
        t0 = Date.now()
        attempt.timings.refLoadMs = await browser.load(
          `${s.store}/products/${s.handle}?sca_ref=${encodeURIComponent(s.ref)}`,
          s.loadTimeoutMs,
        )
        done(st, true, undefined, t0)

        st = push('Affiliate kimliği bekleniyor (_up_click_id)…')
        const up = await pollUp(sum.cartToken)
        seen = up.seen
        attempt.upClickIdSeen = up.seen
        attempt.timings.upClickIdMs = up.ms
        done(
          st,
          up.seen,
          up.seen
            ? `UCP sepetinde görüldü (${up.info?.upHead}…)`
            : `${s.upWaitMs / 1000} sn içinde gelmedi · token ${attempt.tokenMatchAfterRef ? '= UCP' : '≠ UCP'}`,
        )
      } finally {
        // Always put the user's own store cart back (spec rule 3).
        if (cookieSet || prev !== null) {
          const st = push('Önceki sepet geri yükleniyor…')
          try {
            attempt.prevCartRestored = await browser.run<boolean>(JS.restoreCartCookie(prev))
            done(st, attempt.prevCartRestored, prev ? 'önceki çerez geri yazıldı' : 'cart çerezi silindi')
          } catch (e) {
            attempt.prevCartRestored = false
            done(st, false, (e as Error).message)
          }
        }
      }

      if (seen) {
        result = {
          attempt,
          summary: sum,
          paymentUrl: sum.continueUrl ? withRef(sum.continueUrl) : undefined,
          affiliateNote: 'Affiliate kimliği UCP sepetine UpPromote’un kendi kodu tarafından yazıldı.',
        }
      } else {
        attempt.error = 'affiliate kimliği yazılmadı'
        if (s.fallbackC === 'stop') {
          attempt.outcome = 'stopped'
          attempt.timings.totalPrepMs = Date.now() - started
          return { attempt, summary: sum, affiliateNote: 'Affiliate kimliği yazılmadı — ayar gereği durduruldu.' }
        }
        if (s.fallbackC === 'D') {
          attempt.fallbackUsed = 'D'
          result = {
            attempt,
            summary: sum,
            paymentUrl: sum.continueUrl ? appendParam(sum.continueUrl, 'sca_ref', s.ref) : undefined,
            affiliateNote: 'Kimlik yazılmadı → Mod D: affiliate takibi belirsiz (piksele bağlı).',
          }
        } else {
          attempt.fallbackUsed = 'B'
          result = await modeB(true)
          result.summary = sum
        }
      }
    }

    attempt.timings.totalPrepMs = Date.now() - started
    attempt.outcome = 'ok'
    if (result.paymentUrl) attempt.paymentUrlMasked = maskUrl(result.paymentUrl)
    return result
  } catch (e) {
    attempt.outcome = 'error'
    attempt.error = (e as Error).message
    attempt.timings.totalPrepMs = Date.now() - started
    return { attempt, affiliateNote: '' }
  }
}

/** Open the payment page with the chosen option. Never completes payment. */
export async function openPayment(p: Prepared, s: Settings, browser: BrowserHandle): Promise<string> {
  if (!p.paymentUrl) throw new Error('Açılacak ödeme adresi yok')
  if (p.forceBrowser || s.opening === 'webview') {
    browser.show(p.paymentUrl)
    return 'Görünür WebView açıldı'
  }
  if (s.opening === 'inapp') {
    const r = await WebBrowser.openBrowserAsync(p.paymentUrl, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    })
    return `Uygulama içi tarayıcı kapandı (${r.type})`
  }
  await Linking.openURL(p.paymentUrl)
  return 'Dış tarayıcıda açıldı'
}
