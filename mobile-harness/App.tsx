// Kauna mobile test harness — four payment modes, selectable in-app.
// TEST ONLY: payment is never completed; _up_click_id is never written by us.
import { StatusBar } from 'expo-status-bar'
import { useEffect, useRef, useState } from 'react'
import { Platform, Pressable, StatusBar as RNStatusBar, Text, View } from 'react-native'

import { Browser, type BrowserHandle } from './src/Browser'
import { loadSettings, saveSettings, type Settings } from './src/config'
import { openPayment, prepare, type Prepared, type Step } from './src/flows'
import { newAttemptId } from './src/ids'
import { saveAttempt, type Attempt } from './src/log'
import type { UcpSummary } from './src/api'
import { LogScreen } from './src/screens/LogScreen'
import { PrepareScreen } from './src/screens/PrepareScreen'
import { ProductScreen } from './src/screens/ProductScreen'
import { SettingsScreen } from './src/screens/SettingsScreen'
import { C, TestBanner } from './src/ui'

type Tab = 'product' | 'prepare' | 'log' | 'settings'

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>('product')
  const [steps, setSteps] = useState<Step[]>([])
  const [summary, setSummary] = useState<UcpSummary>()
  const [prepared, setPrepared] = useState<Prepared>()
  const [running, setRunning] = useState(false)
  const [openResult, setOpenResult] = useState<string>()
  const [logKey, setLogKey] = useState(0)
  const browser = useRef<BrowserHandle>(null)
  const attemptRef = useRef<Attempt | null>(null)

  useEffect(() => {
    void loadSettings().then(setSettings)
  }, [])

  const persist = async (a: Attempt) => {
    attemptRef.current = a
    await saveAttempt(a)
    setLogKey((k) => k + 1)
  }

  // Runs only from the user's tap on "Satın al" (spec rule 4).
  const onBuy = async (variantId: string) => {
    if (!settings || !browser.current || running) return
    setTab('prepare')
    setSteps([])
    setSummary(undefined)
    setPrepared(undefined)
    setOpenResult(undefined)
    setRunning(true)
    const p = await prepare({
      s: settings,
      variantId,
      attemptId: newAttemptId(),
      browser: browser.current,
      onSteps: setSteps,
      onSummary: setSummary,
    })
    setPrepared(p)
    await persist(p.attempt)
    setRunning(false)
  }

  const onOpen = async () => {
    if (!prepared || !settings || !browser.current) return
    try {
      setOpenResult('Açılıyor…')
      setOpenResult(await openPayment(prepared, settings, browser.current))
    } catch (e) {
      setOpenResult(`Açılamadı: ${(e as Error).message}`)
    }
  }

  if (!settings) return <View style={{ flex: 1, backgroundColor: C.bg }} />

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'ios' ? 50 : RNStatusBar.currentHeight ?? 0 }}>
      <StatusBar style="dark" />
      <TestBanner />
      <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: C.line, backgroundColor: '#fff' }}>
        {(
          [
            ['product', 'Ürün'],
            ['prepare', 'Özet'],
            ['log', 'Günlük'],
            ['settings', 'Ayarlar'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <Pressable key={t} onPress={() => setTab(t)} style={{ flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderColor: tab === t ? C.accent : 'transparent' }}>
            <Text style={{ color: tab === t ? C.accent : C.text, fontWeight: tab === t ? '700' : '500' }}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={{ flex: 1 }}>
        {tab === 'product' && <ProductScreen settings={settings} onBuy={(v) => void onBuy(v)} />}
        {tab === 'prepare' && (
          <PrepareScreen
            steps={steps}
            summary={summary}
            prepared={prepared}
            running={running}
            mode={settings.mode}
            budgetMs={settings.affiliateBudgetMs}
            openResult={openResult}
            onOpen={() => void onOpen()}
            onBack={() => setTab('product')}
            onSaveManual={(patch) => {
              if (attemptRef.current) void persist({ ...attemptRef.current, ...patch })
            }}
          />
        )}
        {tab === 'log' && <LogScreen refreshKey={logKey} />}
        {tab === 'settings' && (
          <SettingsScreen
            value={settings}
            onSave={(s) => {
              setSettings(s)
              void saveSettings(s)
              setTab('product')
            }}
          />
        )}
      </View>

      {/* Single WebView for all in-page steps; becomes visible for the "Görünür WebView" opening. */}
      <Browser
        key={settings.cookieStore}
        ref={browser}
        incognito={settings.cookieStore === 'incognito'}
        onThankYou={() => {
          if (attemptRef.current && !attemptRef.current.thankYouSeen) void persist({ ...attemptRef.current, thankYouSeen: true })
        }}
        onClosed={() => setOpenResult('Görünür WebView kapatıldı')}
      />
    </View>
  )
}
