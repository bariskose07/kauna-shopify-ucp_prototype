'use client'
// Opens the merchant's own payment page (continue_url). Card data never
// touches Kauna (rule 2). Three modes, chosen in Settings:
//   A) Checkout Kit web component (@shopify/checkout-kit, alpha) — popup + ec.* events
//   B) Plain popup / new tab + "closed" polling
//   C) ECP iframe: continue_url + ec_version, JSON-RPC over postMessage
// Every event is written to the debug log via /api/debug/event.

import { useEffect, useRef, useState } from 'react'

import { getPaymentMode, reportEvent, type PaymentMode } from '@/lib/browser'

const KIT_EVENTS = [
  'ec.start',
  'ec.complete',
  'ec.close',
  'ec.error',
  'ec.fulfillment.change',
  'ec.line_items.change',
  'ec.totals.change',
  'ec.messages.change',
  'ec.buyer.change',
  'ec.payment.change',
]
const NO_EVENT_TIMEOUT_MS = 25_000
const DEFAULT_ECP_VERSION = '2026-04-08' // what Checkout Kit 4.0.0-alpha.4 sends

interface Props {
  seller: string
  continueUrl: string
  ucpVersion?: string
  scenario?: string
  onClosed: () => void
}

interface EventLine {
  at: string
  text: string
}

type KitElement = HTMLElement & {
  src: string
  target: string
  logLevel: string
  allowedOrigins: string[]
  onMessageRejected?: (d: unknown) => void
  open: () => void
  close: () => void
}

export function PaymentLauncher({ seller, continueUrl, ucpVersion, scenario, onClosed }: Props) {
  const [mode, setMode] = useState<PaymentMode>('B')
  const [events, setEvents] = useState<EventLine[]>([])
  const [kitState, setKitState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [suggestB, setSuggestB] = useState<string | null>(null)
  const [blockedLink, setBlockedLink] = useState(false)
  const [iframeOn, setIframeOn] = useState(false)
  const [probe, setProbe] = useState<Record<string, unknown> | null>(null)
  const [note, setNote] = useState('')
  const kitRef = useRef<KitElement | null>(null)
  const sawEvent = useRef(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const log = (text: string, outcome?: string, event?: unknown) => {
    setEvents((e) => [...e, { at: new Date().toLocaleTimeString(), text }])
    void reportEvent({ seller, scenario, mode, outcome, detail: text, event })
  }

  useEffect(() => setMode(getPaymentMode()), [])

  // ── Mode A: preload the web component so open() runs inside the click
  // gesture (an `await import()` inside onClick would get the popup blocked).
  useEffect(() => {
    if (mode !== 'A') return
    let cancelled = false
    import('@shopify/checkout-kit')
      .then(() => {
        if (cancelled) return
        const el = document.createElement('shopify-checkout') as KitElement
        el.src = continueUrl
        el.target = 'popup'
        el.logLevel = 'debug'
        // src origin + shop.app are trusted by default; the checkout may also
        // live on the shop's myshopify domain.
        el.allowedOrigins = [new URL(seller).origin, 'https://*.myshopify.com']
        el.onMessageRejected = (d) => log(`Mesaj reddedildi (origin allowlist dışında)`, 'message-rejected', d)
        for (const name of KIT_EVENTS) {
          el.addEventListener(name, (ev) => {
            sawEvent.current = true
            const detail = (ev as CustomEvent).detail
            log(`${name}${name === 'ec.error' ? `: ${JSON.stringify(detail?.error?.messages ?? detail)}` : ''}`, name, detail)
            if (name === 'ec.close') onClosed()
            if (name === 'ec.complete') log('ec.complete alındı — SİPARİŞ VERİLMİŞ OLABİLİR! Mağazada iptal edin.', 'ORDER-PLACED')
          })
        }
        document.body.append(el)
        kitRef.current = el
        setKitState('ready')
      })
      .catch((e: unknown) => {
        setKitState('failed')
        setSuggestB(`Checkout Kit yüklenemedi: ${(e as Error).message}`)
        void reportEvent({ seller, scenario, mode: 'A', outcome: 'kit-load-failed', detail: (e as Error).message })
      })
    return () => {
      cancelled = true
      kitRef.current?.remove()
      kitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, continueUrl])

  function openA() {
    const el = kitRef.current
    if (!el) return
    sawEvent.current = false
    el.open()
    log('Checkout Kit open() çağrıldı (popup)', 'opened')
    setTimeout(() => {
      if (!sawEvent.current) {
        const msg =
          'Checkout Kit 25 sn içinde hiçbir ec.* olayı almadı: popup engellenmiş olabilir ya da continue_url ECP’yi desteklemiyor.'
        setSuggestB(msg)
        log(msg, 'no-ecp-events')
      }
    }, NO_EVENT_TIMEOUT_MS)
  }

  // ── Mode B: plain window; detect when the buyer closes it.
  function openB() {
    const w = window.open(continueUrl, '_blank')
    if (!w) {
      setBlockedLink(true)
      log('Açılır pencere engellendi — bağlantıya dokunarak açın.', 'popup-blocked')
      return
    }
    try {
      w.opener = null // still about:blank here, so allowed; avoids reverse tabnabbing
    } catch {
      /* ignore */
    }
    log('continue_url yeni pencerede açıldı', 'opened')
    const t = setInterval(() => {
      if (w.closed) {
        clearInterval(t)
        log('Pencere kapandı', 'closed')
        onClosed()
      }
    }, 1000)
  }

  // ── Mode C: ECP in an iframe.
  const ecpUrl = (() => {
    const u = new URL(continueUrl)
    u.searchParams.set('ec_version', ucpVersion && /^\d{4}-\d{2}-\d{2}$/.test(ucpVersion) ? ucpVersion : DEFAULT_ECP_VERSION)
    return u.toString()
  })()

  useEffect(() => {
    if (!iframeOn) return
    let ready = false
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      if (!e.origin.startsWith('https://')) return
      let msg: { jsonrpc?: string; id?: string | number; method?: string; params?: unknown }
      try {
        msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
      } catch {
        return
      }
      if (msg?.jsonrpc !== '2.0' || !msg.method) return
      if (msg.method === 'ec.ready') ready = true
      log(`${msg.method} (${e.origin})`, msg.method, msg.params)
      if (msg.id !== undefined && msg.id !== null) {
        // Requests need a response. We accept ready and delegate nothing else.
        const reply =
          msg.method === 'ec.ready'
            ? { jsonrpc: '2.0', id: msg.id, result: { ucp: { status: 'success', version: ucpVersion ?? DEFAULT_ECP_VERSION } } }
            : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }
        e.source?.postMessage(reply, { targetOrigin: e.origin })
      }
      if (msg.method === 'ec.complete') log('ec.complete — SİPARİŞ VERİLMİŞ OLABİLİR! Mağazada iptal edin.', 'ORDER-PLACED')
    }
    window.addEventListener('message', onMessage)
    const t = setTimeout(() => {
      if (!ready) log('20 sn içinde ec.ready gelmedi — mağaza iframe’i engelliyor olabilir (X-Frame-Options / frame-ancestors).', 'no-ec-ready')
    }, 20_000)
    return () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeOn])

  async function openC() {
    setIframeOn(true)
    log(`ECP iframe yükleniyor: ec_version eklendi`, 'opened')
    try {
      const r = await fetch(`/api/probe-frame?url=${encodeURIComponent(continueUrl)}`)
      const j = (await r.json()) as Record<string, unknown>
      setProbe(j)
      log(`Çerçeve başlıkları: XFO=${String(j.xFrameOptions)} frame-ancestors=${String(j.frameAncestors)}`, j.likelyBlocked ? 'iframe-blocked-headers' : 'iframe-headers-ok')
    } catch {
      /* probe is advisory */
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Ödeme sayfası</h2>
      <div className="notice danger small">
        Mağaza sayfası açılınca alanları ve hızlı ödeme butonlarını incele; <strong>“Siparişi tamamla / Pay now”a basma</strong>.
      </div>
      <p className="small muted">
        Mod: <strong>{mode === 'A' ? 'A – Checkout Kit (web)' : mode === 'B' ? 'B – Açılır pencere / yeni sekme' : 'C – ECP iframe'}</strong>{' '}
        (Ayarlar’dan değiştir)
      </p>

      {mode === 'A' && (
        <button className="primary" onClick={openA} disabled={kitState !== 'ready'}>
          {kitState === 'loading' ? 'Checkout Kit yükleniyor…' : 'Ödeme sayfasını aç (Checkout Kit)'}
        </button>
      )}
      {mode === 'B' && (
        <button className="primary" onClick={openB}>
          Ödeme sayfasını aç
        </button>
      )}
      {mode === 'C' && !iframeOn && (
        <button className="primary" onClick={() => void openC()}>
          Ödeme sayfasını uygulama içinde aç (ECP)
        </button>
      )}

      {suggestB && (
        <div className="notice warn small">
          {suggestB}{' '}
          <button
            onClick={() => {
              log('A → B moduna düşüldü', 'fallback-to-B')
              openB()
            }}
          >
            B moduyla aç
          </button>
        </div>
      )}
      {blockedLink && (
        <p>
          <a href={continueUrl} target="_blank" rel="noopener noreferrer">
            Ödeme sayfasını aç →
          </a>
        </p>
      )}

      {mode === 'C' && iframeOn && (
        <>
          {probe && Boolean(probe.likelyBlocked) && (
            <div className="notice warn small">
              Mağaza başlıkları iframe’i engelliyor gibi görünüyor (X-Frame-Options: {String(probe.xFrameOptions)}, {String(probe.frameAncestors)}).
            </div>
          )}
          <iframe
            ref={iframeRef}
            className="frame"
            src={ecpUrl}
            title="Mağaza ödeme sayfası (ECP)"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            allow="payment *; publickey-credentials-get *"
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              onClick={() => {
                setIframeOn(false)
                log('ECP iframe kapatıldı', 'closed')
                onClosed()
              }}
            >
              Paneli kapat
            </button>
          </div>
        </>
      )}

      <details style={{ marginTop: 10 }}>
        <summary className="small">Olay günlüğü ({events.length})</summary>
        <div className="small mono">
          {events.map((e, i) => (
            <div key={i}>
              {e.at} — {e.text}
            </div>
          ))}
        </div>
      </details>

      <div className="field" style={{ marginTop: 10 }}>
        <label>Mod sonucu (senaryo 8: sayfa açıldı mı, alanlar dolu mu, hangi hızlı ödeme butonları var?)</label>
        <div className="row">
          <input className="grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="ör. açıldı; e-posta+adres dolu; Shop Pay, Apple Pay, PayPal" />
          <button
            onClick={() => {
              if (!note.trim()) return
              log(note.trim(), 'manual-note')
              setNote('')
            }}
          >
            Kaydet
          </button>
        </div>
      </div>
    </div>
  )
}
