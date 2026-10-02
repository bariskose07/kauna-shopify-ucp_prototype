// Product: name, image, size picker, "Satın al" showing the selected mode.
// Product data comes straight from the storefront's public /products/{handle}.js.
import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, ScrollView, Text, View } from 'react-native'

import { MODE_LABEL, OPENING_LABEL, type Settings } from '../config'
import { Btn, C, Card, Notice, Seg, s } from '../ui'

interface StoreProduct {
  title: string
  featured_image?: string
  variants: { id: number; title: string; available: boolean; price: number }[]
}

export function ProductScreen({ settings, onBuy }: { settings: Settings; onBuy: (variantId: string) => void }) {
  const [p, setP] = useState<StoreProduct | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [variant, setVariant] = useState(settings.variants[0]?.id ?? '')

  useEffect(() => {
    setP(null)
    setErr(null)
    fetch(`${settings.store}/products/${settings.handle}.js`, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setP)
      .catch((e: Error) => setErr(`Ürün okunamadı: ${e.message}`))
  }, [settings.store, settings.handle])

  const img = p?.featured_image ? (p.featured_image.startsWith('//') ? `https:${p.featured_image}` : p.featured_image) : undefined
  const sv = p?.variants.find((v) => String(v.id) === variant)

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Card>
        {img ? (
          <Image source={{ uri: img }} style={{ width: '100%', aspectRatio: 3 / 4, borderRadius: 12, backgroundColor: '#eee' }} />
        ) : (
          <View style={{ width: '100%', aspectRatio: 3 / 4, borderRadius: 12, backgroundColor: '#eee', alignItems: 'center', justifyContent: 'center' }}>
            {err ? null : <ActivityIndicator />}
          </View>
        )}
        <Text style={[s.h1, { marginTop: 12 }]}>{p?.title ?? settings.handle}</Text>
        {sv && (
          <Text style={s.p}>
            ${(sv.price / 100).toFixed(2)} · {sv.available ? 'Stokta' : 'Stokta yok'}
          </Text>
        )}
        {err && <Notice tone="warn">{err}</Notice>}
        <Text style={[s.label, { marginTop: 12 }]}>Beden</Text>
        <Seg
          value={variant}
          options={settings.variants.map((v) => [v.id, p?.variants.find((x) => String(x.id) === v.id)?.title ?? v.label] as [string, string])}
          onChange={setVariant}
        />
        <Text style={s.mono}>varyant {variant} → gid://shopify/ProductVariant/{variant}</Text>
      </Card>

      <Card>
        <Text style={s.muted}>Seçili ödeme modu</Text>
        <Text style={[s.p, { fontWeight: '700', marginBottom: 2 }]}>{MODE_LABEL[settings.mode]}</Text>
        <Text style={s.muted}>
          Açılış: {OPENING_LABEL[settings.opening]}
          {settings.mode === 'C' ? ` · sca_ref ${settings.scaRefOnContinue ? 'açık' : 'kapalı'} · düşüş: ${settings.fallbackC}` : ''}
          {' · '}çerez: {settings.cookieStore === 'incognito' ? 'gizli' : 'kalıcı'}
        </Text>
        <View style={{ height: 12 }} />
        <Btn primary label={`Satın al (${settings.mode})`} onPress={() => onBuy(variant)} disabled={!variant} />
      </Card>
      <Text style={[s.muted, { textAlign: 'center', color: C.muted }]}>Sunucu: {settings.serverUrl}</Text>
    </ScrollView>
  )
}
