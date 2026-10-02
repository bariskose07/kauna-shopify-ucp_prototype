// Test log: every attempt with steps and timings; Markdown / CSV export via
// the system share sheet (to match against UpPromote referrals later).
import { useCallback, useEffect, useState } from 'react'
import { Alert, Pressable, ScrollView, Share, Text, View } from 'react-native'

import { clearLog, loadLog, toCsv, toMarkdown, type Attempt } from '../log'
import { Btn, C, Card, s } from '../ui'

export function LogScreen({ refreshKey }: { refreshKey: number }) {
  const [list, setList] = useState<Attempt[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const reload = useCallback(() => void loadLog().then(setList), [])
  useEffect(reload, [reload, refreshKey])

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <View style={[s.row, { marginBottom: 12, flexWrap: 'wrap' }]}>
        <Btn small label="Markdown paylaş" onPress={() => void Share.share({ message: toMarkdown(list) })} disabled={!list.length} />
        <Btn small label="CSV paylaş" onPress={() => void Share.share({ message: toCsv(list) })} disabled={!list.length} />
        <Btn
          small
          label="Temizle"
          onPress={() =>
            Alert.alert('Günlük silinsin mi?', '', [
              { text: 'Vazgeç', style: 'cancel' },
              { text: 'Sil', style: 'destructive', onPress: () => void clearLog().then(reload) },
            ])
          }
          disabled={!list.length}
        />
      </View>
      {list.length === 0 && <Text style={s.muted}>Henüz deneme yok.</Text>}
      {list.map((a) => (
        <Card key={a.id}>
          <Pressable onPress={() => setOpen(open === a.id ? null : a.id)}>
            <Text style={[s.small, { fontWeight: '700' }]}>
              {a.mode} · {a.opening}
            </Text>
            <Text style={s.muted}>
              {a.at.replace('T', ' ').slice(0, 19)} · {a.platform} ·{' '}
              <Text style={{ color: a.outcome === 'ok' ? C.ok : a.outcome === 'error' ? C.danger : C.muted }}>{a.outcome}</Text>
              {a.upClickIdSeen !== undefined && a.upClickIdSeen !== null ? ` · _up_click_id ${a.upClickIdSeen ? '✓' : '✗'}` : ''}
              {a.fallbackUsed ? ` · düşüş ${a.fallbackUsed}` : ''}
            </Text>
            <Text style={s.mono}>{a.id}</Text>
          </Pressable>
          {open === a.id && (
            <View style={{ marginTop: 8 }}>
              {a.error ? <Text style={[s.small, { color: C.danger }]}>Hata: {a.error}</Text> : null}
              <Text style={s.muted}>Süreler: {Object.entries(a.timings).map(([k, v]) => `${k}=${v}`).join(', ')}</Text>
              <Text style={s.muted}>UCP: {a.status ?? '—'} · {a.authModes ?? ''}</Text>
              {a.ucpMessages ? <Text style={s.muted}>Mesajlar: {a.ucpMessages}</Text> : null}
              {a.paymentUrlMasked ? <Text style={s.mono}>{a.paymentUrlMasked}</Text> : null}
              {a.steps.map((st, i) => (
                <Text key={i} style={s.muted}>
                  {st.ok ? '✓' : '✗'} {st.label}
                  {st.ms !== undefined ? ` (${st.ms} ms)` : ''}
                  {st.detail ? ` — ${st.detail}` : ''}
                </Text>
              ))}
              <Text style={s.muted}>
                Ön doldurma: {a.prefillWorked ?? '?'} · Hızlı ödeme: {a.expressButtons || '—'}
                {a.thankYouSeen ? ' · thank-you görüldü!' : ''}
              </Text>
              {a.notes ? <Text style={s.muted}>Not: {a.notes}</Text> : null}
            </View>
          )}
        </Card>
      ))}
    </ScrollView>
  )
}
