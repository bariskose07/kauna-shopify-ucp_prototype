// Summary / preparation: UCP summary + WebView step progress, then the
// user taps to open the payment page. Manual observations go into the log.
import { useEffect, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'

import { formatMoney, type UcpSummary } from '../api'
import type { Prepared, Step } from '../flows'
import { mask6 } from '../ids'
import type { Attempt } from '../log'
import { Btn, C, Card, Field, Notice, Seg, s } from '../ui'

interface Props {
  steps: Step[]
  summary?: UcpSummary
  prepared?: Prepared
  running: boolean
  mode: string
  /** Mode C affiliate budget, for the "preparing" hint. */
  budgetMs: number
  openResult?: string
  onOpen: () => void
  onSaveManual: (patch: Pick<Attempt, 'prefillWorked' | 'expressButtons' | 'notes'>) => void
  onBack: () => void
}

const ICON: Record<Step['state'], string> = { run: '⏳', ok: '✓', fail: '✗', skip: '–' }

// Layout: the UCP summary comes first (it arrives in ~1–3 s) so the buyer
// reads it while the affiliate preparation finishes in the background; the
// payment button turns on when that is done (or its time budget runs out).
export function PrepareScreen({ steps, summary, prepared, running, mode, budgetMs, openResult, onOpen, onSaveManual, onBack }: Props) {
  const [prefill, setPrefill] = useState<'evet' | 'hayır' | '?'>('?')
  const [express, setExpress] = useState('')
  const [notes, setNotes] = useState('')
  const [saved, setSaved] = useState(false)
  const a = prepared?.attempt
  // Seconds since the summary appeared, for the "hazırlanıyor" hint.
  const [since, setSince] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (summary && running && since === null) setSince(Date.now())
    if (!running) setSince(null)
  }, [summary, running, since])
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [running])
  const waited = since ? Math.max(0, Math.round((now - since) / 1000)) : 0

  const hazirlik = (
    <Card title="Hazırlık">
      {steps.map((st, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8, paddingVertical: 4 }}>
          <Text style={{ width: 18, color: st.state === 'fail' ? C.danger : st.state === 'ok' ? C.ok : C.muted }}>{ICON[st.state]}</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.small}>
              {st.label}
              {st.ms !== undefined ? <Text style={s.muted}> · {st.ms} ms</Text> : null}
            </Text>
            {st.detail ? <Text style={s.muted}>{st.detail}</Text> : null}
          </View>
        </View>
      ))}
      {running && <Text style={[s.muted, { marginTop: 6 }]}>Çalışıyor…</Text>}
      {a?.timings.totalPrepMs !== undefined && <Text style={[s.muted, { marginTop: 6 }]}>Toplam hazırlık: {a.timings.totalPrepMs} ms</Text>}
    </Card>
  )

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      {!summary && hazirlik}
      {summary && (
        <Card title="Sipariş özeti (UCP)">
          {summary.lineItems.map((l, i) => (
            <Text key={i} style={s.small}>
              {l.title ?? 'Ürün'} × {l.quantity}
            </Text>
          ))}
          <View style={{ height: 6 }} />
          {summary.totals.map((t, i) => (
            <View key={i} style={s.between}>
              <Text style={[s.small, t.type === 'total' && { fontWeight: '700' }]}>{t.display_text ?? t.type}</Text>
              <Text style={[s.small, t.type === 'total' && { fontWeight: '700' }]}>{formatMoney(t.amount, summary.currency)}</Text>
            </View>
          ))}
          {!summary.shipping.present && (
            <View style={s.between}>
              <Text style={s.small}>Kargo</Text>
              <Text style={s.muted}>{summary.shipping.text}</Text>
            </View>
          )}
          <Text style={[s.muted, { marginTop: 6 }]}>
            Durum: {summary.status} · kimlik yolu: {summary.auth.map((x) => `${x.step}: ${x.auth?.mode === 'fallback' ? '⚠ ' : ''}${x.auth?.label ?? x.auth?.mode}`).join(', ')}
          </Text>
          {summary.buyerWarnings.length > 0 && (
            <Notice tone="danger">
              <Text style={[s.small, { fontWeight: '700' }]}>Alıcı / adres bilgisi işlenmemiş olabilir</Text>
              {summary.buyerWarnings.map((w, i) => (
                <Text key={i} style={s.small}>
                  {w.code}: {w.content}
                </Text>
              ))}
            </Notice>
          )}
          {summary.messages
            .filter((m) => !summary.buyerWarnings.some((w) => w.code === m.code))
            .map((m, i) => (
              <Notice key={i} tone={m.severity === 'requires_buyer_input' || m.code === 'extension_interaction_required' ? 'warn' : 'info'}>
                {`${m.code ?? m.type}${m.severity ? ` (${m.severity})` : ''}: ${m.content ?? ''}`}
              </Notice>
            ))}
          {summary.fieldNotes.length > 0 && <Text style={s.muted}>{summary.fieldNotes.join(' · ')}</Text>}
        </Card>
      )}

      {(prepared || (summary && running)) && (
        <Card title="Ödeme sayfası">
          {a?.outcome === 'error' && <Notice tone="danger">{`Hata: ${a.error}`}</Notice>}
          {prepared?.affiliateNote ? <Notice tone={a?.upClickIdSeen ? 'ok' : 'warn'}>{prepared.affiliateNote}</Notice> : null}
          {a?.mode.startsWith('C') && (
            <Text style={s.muted}>
              token eşleşti: çerez sonrası {fmt(a.tokenMatchAfterCookie)}, ref sonrası {fmt(a.tokenMatchAfterRef)} · _up_click_id {fmt(a.upClickIdSeen)} · önceki sepet geri
              yüklendi {fmt(a.prevCartRestored)}
            </Text>
          )}
          {a?.paymentUrlMasked ? <Text style={[s.mono, { marginVertical: 6 }]}>{a.paymentUrlMasked}</Text> : null}
          <Notice tone="danger">“Siparişi tamamla / Pay now”a basma. Yalnızca alanları ve hızlı ödeme butonlarını incele.</Notice>
          {running ? (
            <>
              <Btn primary label={`Hazırlanıyor… ${waited} sn`} onPress={() => {}} disabled />
              <Text style={[s.muted, { marginTop: 6 }]}>
                {mode.startsWith('C')
                  ? `Affiliate bağlantısı kuruluyor; en fazla ${Math.round(budgetMs / 1000)} sn sonra ödeme sayfası her durumda açılabilir. Bu sırada özeti inceleyin.`
                  : 'Ödeme sayfası hazırlanıyor…'}
              </Text>
            </>
          ) : (
            <Btn primary label="Ödeme sayfasını aç" onPress={onOpen} disabled={!prepared?.paymentUrl} />
          )}
          {openResult ? <Text style={[s.muted, { marginTop: 6 }]}>{openResult}</Text> : null}
        </Card>
      )}

      {summary && hazirlik}

      {prepared && (
        <Card title="Gözlem (günlüğe)">
          <Text style={s.label}>Ön doldurma çalıştı mı?</Text>
          <Seg value={prefill} options={[['evet', 'Evet'], ['hayır', 'Hayır'], ['?', 'Bilinmiyor']]} onChange={setPrefill} />
          <Field label="Hızlı ödeme butonları" value={express} onChangeText={setExpress} placeholder="ör. Shop Pay, Apple Pay, PayPal" />
          <Field label="Notlar" value={notes} onChangeText={setNotes} multiline style={{ minHeight: 60 }} />
          <Btn
            label={saved ? 'Kaydedildi ✓' : 'Günlüğe kaydet'}
            onPress={() => {
              onSaveManual({ prefillWorked: prefill, expressButtons: express, notes })
              setSaved(true)
            }}
          />
          <Text style={[s.mono, { marginTop: 8 }]}>Deneme: {a?.id} · checkout {a?.checkoutIdMasked ?? '—'} · cart {mask6(summary?.cartToken)}</Text>
        </Card>
      )}
      <Btn label="← Ürüne dön" onPress={onBack} disabled={running} />
    </ScrollView>
  )
}

const fmt = (v: boolean | null | undefined) => (v === true ? 'evet' : v === false ? 'hayır' : '—')
