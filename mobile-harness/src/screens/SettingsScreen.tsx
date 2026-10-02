// Configuration screen (all values persisted on the device).
import { useState } from 'react'
import { ScrollView, Switch, Text, View } from 'react-native'

import { DEFAULTS, type BTarget, type CookieStore, type FallbackC, type Mode, type Opening, type Settings } from '../config'
import { Btn, Card, Field, Seg, s } from '../ui'

export function SettingsScreen({ value, onSave }: { value: Settings; onSave: (s: Settings) => void }) {
  const [v, setV] = useState<Settings>(value)
  const set = <K extends keyof Settings>(k: K, val: Settings[K]) => setV({ ...v, [k]: val })
  const setBuyer = (k: keyof Settings['buyer'], val: string) => setV({ ...v, buyer: { ...v.buyer, [k]: val } })

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Card title="Ödeme">
        <Text style={s.label}>Ödeme modu</Text>
        <Seg<Mode> value={v.mode} options={[['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']]} onChange={(m) => set('mode', m)} />
        <Text style={s.muted}>A: sadece UCP · B: mağaza sepeti · C: UCP + çerez · D: UCP + sca_ref</Text>
        <Text style={[s.label, { marginTop: 10 }]}>Ödeme sayfası açılışı</Text>
        <Seg<Opening>
          value={v.opening}
          options={[
            ['inapp', 'Uyg. içi'],
            ['webview', 'WebView'],
            ['external', 'Dış'],
          ]}
          onChange={(o) => set('opening', o)}
        />
        <View style={[s.row, { justifyContent: 'space-between', marginVertical: 6 }]}>
          <Text style={s.small}>continue_url’e sca_ref ekle (Mod C)</Text>
          <Switch value={v.scaRefOnContinue} onValueChange={(b) => set('scaRefOnContinue', b)} />
        </View>
        <Text style={s.label}>Kimlik yazılmazsa (Mod C)</Text>
        <Seg<FallbackC>
          value={v.fallbackC}
          options={[
            ['D', 'Mod D’ye düş'],
            ['B', 'Mod B’ye düş'],
            ['stop', 'Dur'],
          ]}
          onChange={(f) => set('fallbackC', f)}
        />
        <Text style={s.label}>WebView çerez deposu</Text>
        <Seg<CookieStore>
          value={v.cookieStore}
          options={[
            ['persistent', 'Kalıcı'],
            ['incognito', 'Gizli'],
          ]}
          onChange={(c) => set('cookieStore', c)}
        />
        <Text style={s.label}>Mod B ödeme adresi</Text>
        <Seg<BTarget>
          value={v.bTarget}
          options={[
            ['cart_c', '/cart/c/{token}'],
            ['checkout_same_webview', '/checkout (WebView)'],
          ]}
          onChange={(b) => set('bTarget', b)}
        />
      </Card>

      <Card title="Mağaza ve ürün">
        <Field label="Sunucu adresi (bilgisayarın yerel IP’si veya tünel)" value={v.serverUrl} onChangeText={(t) => set('serverUrl', t.trim())} keyboardType="url" />
        <Field label="Mağaza" value={v.store} onChangeText={(t) => set('store', t.trim().replace(/\/$/, ''))} keyboardType="url" />
        <Field label="Ref kodu (sca_ref)" value={v.ref} onChangeText={(t) => set('ref', t.trim())} />
        <Field label="Ürün handle" value={v.handle} onChangeText={(t) => set('handle', t.trim())} />
        {v.variants.map((va, i) => (
          <View key={i} style={s.row}>
            <View style={{ flex: 1 }}>
              <Field
                label={`Varyant ${i + 1} etiketi`}
                value={va.label}
                onChangeText={(t) => set('variants', v.variants.map((x, j) => (j === i ? { ...x, label: t } : x)))}
              />
            </View>
            <View style={{ flex: 1.4 }}>
              <Field
                label="Sayısal kimlik"
                value={va.id}
                keyboardType="number-pad"
                onChangeText={(t) => set('variants', v.variants.map((x, j) => (j === i ? { ...x, id: t.replace(/\D/g, '') } : x)))}
              />
            </View>
          </View>
        ))}
      </Card>

      <Card title="Alıcı (yalnızca test verisi)">
        {(Object.keys(v.buyer) as (keyof Settings['buyer'])[]).map((k) => (
          <Field key={k} label={k} value={v.buyer[k]} onChangeText={(t) => setBuyer(k, t)} />
        ))}
      </Card>

      <Card title="Bekleme süreleri (ms)">
        <Field label="_up_click_id için en fazla" value={String(v.upWaitMs)} keyboardType="number-pad" onChangeText={(t) => set('upWaitMs', Number(t) || 8000)} />
        <Field label="Sayfa yükleme zaman aşımı" value={String(v.loadTimeoutMs)} keyboardType="number-pad" onChangeText={(t) => set('loadTimeoutMs', Number(t) || 15000)} />
      </Card>

      <View style={{ gap: 8 }}>
        <Btn primary label="Kaydet" onPress={() => onSave(v)} />
        <Btn label="Varsayılanlara dön" onPress={() => setV({ ...DEFAULTS, serverUrl: v.serverUrl })} />
      </View>
    </ScrollView>
  )
}
