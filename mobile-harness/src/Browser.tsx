// One WebView instance used for every in-page step of an attempt, so cookies
// (incl. incognito sessions) survive across steps. It stays invisible while
// preparing and can be shown full-screen for the "Görünür WebView" opening.
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview'

import { hostPath } from './ids'

export interface BrowserHandle {
  /** Navigate (same instance) and wait for the main-frame load. */
  load(url: string, timeoutMs: number): Promise<number>
  /** Run an async JS body in the page; resolves with its return value. */
  run<T = unknown>(body: string, timeoutMs?: number): Promise<T>
  show(url?: string): void
  hide(): void
  reset(): void
  /** Abort an in-flight navigation (used when the affiliate time budget runs out). */
  stop(): void
}

interface Props {
  incognito: boolean
  onThankYou?: (url: string) => void
  onClosed?: () => void
}

type Waiter = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

let seq = 0

export const Browser = forwardRef<BrowserHandle, Props>(function Browser({ incognito, onThankYou, onClosed }, ref) {
  const wv = useRef<WebView>(null)
  const [uri, setUri] = useState<string | null>(null)
  // Mirror of `uri` that is current even inside a stale handle (prepare()
  // keeps the handle it was given; reset() + load() can run in one tick).
  const uriRef = useRef<string | null>(null)
  const [session, setSession] = useState(0)
  const [visible, setVisible] = useState(false)
  const [currentUrl, setCurrentUrl] = useState('')
  const loadWaiter = useRef<(Waiter & { started: number }) | null>(null)
  const pending = useRef(new Map<string, Waiter>())

  const navigate = (url: string) => {
    if (!uriRef.current) {
      uriRef.current = url
      setUri(url)
    } else wv.current?.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`)
  }

  useImperativeHandle(ref, () => ({
    load(url, timeoutMs) {
      return new Promise<number>((resolve, reject) => {
        if (loadWaiter.current) clearTimeout(loadWaiter.current.timer)
        const started = Date.now()
        loadWaiter.current = {
          started,
          resolve: () => resolve(Date.now() - started),
          reject,
          timer: setTimeout(() => {
            loadWaiter.current = null
            reject(new Error(`Sayfa ${timeoutMs / 1000} sn içinde yüklenmedi: ${hostPath(url).path}`))
          }, timeoutMs),
        }
        navigate(url)
      })
    },
    run<T>(body: string, timeoutMs = 10_000) {
      const id = `r${++seq}`
      const js = `(async () => {
        try { const v = await (async () => { ${body} })();
          window.ReactNativeWebView.postMessage(JSON.stringify({ __id: ${JSON.stringify(id)}, ok: true, value: v === undefined ? null : v }));
        } catch (e) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ __id: ${JSON.stringify(id)}, ok: false, error: String((e && e.message) || e) }));
        } })(); true;`
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.current.delete(id)
          reject(new Error('Sayfa içi adım zaman aşımına uğradı'))
        }, timeoutMs)
        pending.current.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        wv.current?.injectJavaScript(js)
      })
    },
    show(url) {
      if (url) navigate(url)
      setVisible(true)
    },
    hide() {
      setVisible(false)
    },
    reset() {
      // New attempt: fresh instance (a new incognito session in incognito mode).
      uriRef.current = null
      setUri(null)
      setVisible(false)
      setSession((n) => n + 1)
    },
    stop() {
      wv.current?.stopLoading()
      if (loadWaiter.current) {
        clearTimeout(loadWaiter.current.timer)
        loadWaiter.current = null
      }
    },
  }))

  const onMessage = (e: WebViewMessageEvent) => {
    let m: { __id?: string; ok?: boolean; value?: unknown; error?: string }
    try {
      m = JSON.parse(e.nativeEvent.data)
    } catch {
      return
    }
    const w = m.__id ? pending.current.get(m.__id) : undefined
    if (!w || !m.__id) return
    clearTimeout(w.timer)
    pending.current.delete(m.__id)
    if (m.ok) w.resolve(m.value)
    else w.reject(new Error(m.error ?? 'Sayfa içi hata'))
  }

  const onNav = (n: WebViewNavigation) => {
    setCurrentUrl(n.url)
    if (/thank[-_]you/i.test(n.url)) onThankYou?.(n.url)
  }

  return (
    <View style={visible ? styles.full : styles.hidden} pointerEvents={visible ? 'auto' : 'none'}>
      {visible && (
        <View style={styles.bar}>
          <Text style={styles.warn}>TEST – ödemeyi tamamlama, gerçek sipariş verilir</Text>
          <View style={styles.row}>
            <Text style={styles.url} numberOfLines={1}>
              {currentUrl ? hostPath(currentUrl).host + hostPath(currentUrl).path.slice(0, 40) : ''}
            </Text>
            <Pressable
              onPress={() => {
                setVisible(false)
                onClosed?.()
              }}
              style={styles.close}
            >
              <Text style={styles.closeText}>Kapat</Text>
            </Pressable>
          </View>
        </View>
      )}
      {uri && (
        <WebView
          key={session}
          ref={wv}
          source={{ uri }}
          incognito={incognito}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          setSupportMultipleWindows={false}
          onMessage={onMessage}
          onNavigationStateChange={onNav}
          onLoadEnd={() => {
            const w = loadWaiter.current
            if (w) {
              clearTimeout(w.timer)
              loadWaiter.current = null
              w.resolve(undefined)
            }
          }}
          onHttpError={(e) => {
            const w = loadWaiter.current
            if (w && e.nativeEvent.statusCode >= 400) {
              clearTimeout(w.timer)
              loadWaiter.current = null
              w.reject(new Error(`HTTP ${e.nativeEvent.statusCode}`))
            }
          }}
          style={{ flex: 1 }}
        />
      )}
    </View>
  )
})

const styles = StyleSheet.create({
  // Not display:none — the page must keep running JS while hidden.
  hidden: { position: 'absolute', width: 2, height: 2, opacity: 0.01, left: 0, bottom: 0, overflow: 'hidden' },
  full: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#fff', zIndex: 50 },
  bar: { paddingTop: 48, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: '#e8e1d7' },
  warn: { backgroundColor: '#a8251d', color: '#fff', textAlign: 'center', fontWeight: '700', padding: 6, fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8 },
  url: { flex: 1, color: '#6f665d', fontSize: 12 },
  close: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, backgroundColor: '#5c3a26' },
  closeText: { color: '#fff', fontWeight: '600' },
})
