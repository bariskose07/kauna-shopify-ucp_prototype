'use client'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useState } from 'react'

import { PaymentLauncher } from '@/components/PaymentLauncher'
import { ApiFailure, api, formatMoney, sellerOrigin, type ApiError } from '@/lib/browser'
import { SCENARIOS } from '@/lib/scenarios'
import type { CheckoutAnalysis, MissingField } from '@/lib/ucp/analysis'
import { DEFAULT_BUYER, type BuyerInfo, type CommerceObject } from '@/lib/ucp/types'

interface View {
  seller: string
  checkoutId?: string
  draftOrderId: string
  checkout?: CommerceObject
  analysis?: CheckoutAnalysis
  continueUrl?: string
  rawContinueUrl?: string
  ucp?: { version?: unknown; capabilities?: unknown; payment_handlers?: unknown }
  phonePlacement: string
  phoneCandidates?: Record<string, string>
  includePhone: boolean
  discountCodes: string[]
  scenario?: string
  buildNotes: string[]
}

const FIELD_LABELS: Record<keyof BuyerInfo, string> = {
  email: 'E-posta',
  first_name: 'Ad',
  last_name: 'Soyad',
  street_address: 'Sokak adresi',
  address_locality: 'Şehir',
  address_region: 'Eyalet',
  postal_code: 'Posta kodu',
  address_country: 'Ülke',
  phone: 'Telefon (E.164)',
}

function ErrorBox({ e }: { e: ApiError }) {
  const v = e.validation as { unknownFields?: { pointer: string; allowed: string[] }[]; errors?: string[] } | undefined
  return (
    <div className="notice danger small">
      <strong>{e.kind === 'jsonrpc' ? `Protokol hatası ${e.rpcCode ?? ''}` : e.kind}</strong>: {e.message}
      {e.hint && <div>{e.hint}</div>}
      {e.retryAfterSeconds !== undefined && <div>Retry-After: {e.retryAfterSeconds} sn</div>}
      {v?.unknownFields?.map((u) => (
        <div key={u.pointer} className="mono">
          {u.pointer} — şemadaki alanlar: {u.allowed.join(', ')}
        </div>
      ))}
    </div>
  )
}

function MissingFieldForm({ m, onSubmit, busy }: { m: MissingField; onSubmit: (field: keyof BuyerInfo, value: string) => void; busy: boolean }) {
  const [value, setValue] = useState(m.field === 'phone' ? DEFAULT_BUYER.phone : '')
  if (m.field === 'address' || m.field === 'unknown') {
    return (
      <div className="notice warn small">
        <strong>{m.code}</strong>: {m.content} {m.path && <span className="mono">({m.path})</span>}
        <div>Formdaki ilgili alanı düzeltip “Bilgileri güncelle” ile tekrar gönderin.</div>
      </div>
    )
  }
  const field = m.field as keyof BuyerInfo
  return (
    <form
      className="notice warn small"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(field, value)
      }}
    >
      <div>
        <strong>Eksik bilgi: {FIELD_LABELS[field]}</strong> — {m.content ?? m.code}{' '}
        <span className="muted mono">({m.code})</span>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input className="grow" value={value} onChange={(e) => setValue(e.target.value)} required />
        <button className="primary" disabled={busy}>
          Gönder
        </button>
      </div>
    </form>
  )
}

function CheckoutInner() {
  const q = useSearchParams()
  const seller = sellerOrigin(q.get('seller') ?? '')
  const [buyer, setBuyer] = useState<BuyerInfo>(DEFAULT_BUYER)
  const [includePhone, setIncludePhone] = useState(true)
  const [injectWrongField, setInjectWrongField] = useState(false)
  const [scenario, setScenario] = useState('')
  const [view, setView] = useState<View | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [code, setCode] = useState('')
  const [closedOnce, setClosedOnce] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!seller) return
    void api<{ draft: View | null; buyer: BuyerInfo | null }>(`/api/checkout/state?seller=${encodeURIComponent(seller)}`).then((r) => {
      if (r.buyer) setBuyer(r.buyer)
      if (r.draft?.checkoutId) {
        setView(r.draft)
        setIncludePhone(r.draft.includePhone)
        setScenario(r.draft.scenario ?? '')
      }
    })
  }, [seller])

  const call = useCallback(async (fn: () => Promise<View>) => {
    setBusy(true)
    setError(null)
    try {
      setView(await fn())
    } catch (e) {
      if (e instanceof ApiFailure) {
        setError(e.error)
        if (e.body.view) setView(e.body.view as View)
      } else setError({ kind: 'internal', message: String(e) })
    } finally {
      setBusy(false)
    }
  }, [])

  const create = () =>
    call(() =>
      api<View>('/api/checkout', {
        body: { seller, buyer, includePhone, scenario, injectWrongField, discountCodes: code ? [code] : [] },
      }),
    )
  const update = (patch: Record<string, unknown>) =>
    call(() => api<View>('/api/checkout/update', { body: { seller, scenario, injectWrongField, ...patch } }))
  const checkStatus = async () => {
    await call(() => api<View>(`/api/checkout/status?seller=${encodeURIComponent(seller)}`))
    setStatusMsg(`Durum sorgulandı: ${new Date().toLocaleTimeString()}`)
  }

  if (!seller) return <p>Satıcı belirtilmedi. <Link href="/cart">Sepete dön</Link></p>

  const a = view?.analysis
  const co = view?.checkout
  const cur = co?.currency ?? a?.currency

  return (
    <>
      <h1>Checkout · {new URL(seller).host}</h1>

      <div className="card">
        <div className="grid2">
          <div className="field">
            <label>Test senaryosu (bulgular tablosu için etiket)</label>
            <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
              <option value="">—</option>
              {SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}. {s.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Seçenekler</label>
            <label style={{ color: 'inherit' }}>
              <input type="checkbox" checked={includePhone} onChange={(e) => setIncludePhone(e.target.checked)} /> Telefonu gönder
            </label>
            <label style={{ color: 'inherit' }}>
              <input type="checkbox" checked={injectWrongField} onChange={(e) => setInjectWrongField(e.target.checked)} /> Senaryo 5: yanlış alan adı gönder
            </label>
          </div>
        </div>

        <details open={!view}>
          <summary>
            <strong>Alıcı bilgileri</strong> <span className="muted small">(yalnızca sunucu belleğinde tutulur)</span>
          </summary>
          <div className="grid2" style={{ marginTop: 10 }}>
            {(Object.keys(FIELD_LABELS) as (keyof BuyerInfo)[]).map((k) => (
              <div key={k} className="field">
                <label>{FIELD_LABELS[k]}</label>
                <input
                  value={buyer[k]}
                  onChange={(e) => setBuyer({ ...buyer, [k]: e.target.value })}
                  disabled={k === 'address_country'}
                  inputMode={k === 'phone' ? 'tel' : k === 'email' ? 'email' : undefined}
                />
              </div>
            ))}
          </div>
          {!view && (
            <div className="field">
              <label>İndirim kodu (isteğe bağlı)</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ör. KAUNA10" />
            </div>
          )}
        </details>
        <div className="row" style={{ marginTop: 8 }}>
          {!view?.checkoutId ? (
            <button className="primary" onClick={() => void create()} disabled={busy}>
              {busy ? 'Oluşturuluyor…' : 'Checkout oluştur'}
            </button>
          ) : (
            <>
              <button onClick={() => void update({ buyer, includePhone })} disabled={busy}>
                Bilgileri güncelle
              </button>
              <button onClick={() => void create()} disabled={busy}>
                Yeni checkout
              </button>
            </>
          )}
        </div>
      </div>

      {error && <ErrorBox e={error} />}

      {view?.checkoutId && a && (
        <>
          <div className="card">
            <div className="row">
              <span className={`badge ${a.status === 'ready_for_complete' ? 'ok' : a.status === 'requires_escalation' ? 'warn' : a.status === 'completed' ? 'ok' : 'danger'}`}>
                {a.status}
              </span>
              <span className="muted small mono grow">{view.checkoutId}</span>
              <span className="muted small">Kauna taslak no: {view.draftOrderId}</span>
            </div>

            {a.silentFailures.map((s) => (
              <div key={s} className="notice danger small">
                ⚠ {s}
              </div>
            ))}
            {a.unrecoverable.map((m, i) => (
              <div key={i} className="notice danger small">
                {m.code}: {m.content} — bu checkout kullanılamaz, yeni checkout başlatın.
              </div>
            ))}
            {a.missingFields.map((m, i) => (
              <MissingFieldForm
                key={`${m.code}-${i}`}
                m={m}
                busy={busy}
                onSubmit={(field, value) => {
                  const next = { ...buyer, [field]: value }
                  setBuyer(next)
                  if (field === 'phone') setIncludePhone(true)
                  void update({ buyer: { [field]: value }, includePhone: field === 'phone' ? true : includePhone })
                }}
              />
            ))}
            {a.handoff.required && (
              <div className="notice warn">
                <strong>Bu mağaza ödemenin kendi sayfasında tamamlanmasını istiyor.</strong>{' '}
                <span className="small muted">({a.handoff.reason})</span>
                <div className="small">Aşağıdaki “Ödeme sayfası” bölümünden devam edin.</div>
              </div>
            )}
            {[...a.buyerInput, ...a.buyerReview].map((m, i) => (
              <div key={i} className="notice small">
                <span className="mono">{m.code}</span> ({m.severity}): {m.content}
              </div>
            ))}
            {a.warnings.map((m, i) => (
              <div key={i} className="notice warn small">
                {m.presentation === 'disclosure' ? <strong>Bildirim: </strong> : null}
                {m.content} {m.url && <a href={m.url} target="_blank" rel="noreferrer">Ayrıntı</a>}
              </div>
            ))}
            {a.infos.map((m, i) => (
              <div key={i} className="notice small">
                {m.content}
              </div>
            ))}

            <h3>Ürünler</h3>
            {(co?.line_items ?? []).map((li) => (
              <div key={li.id} className="row small" style={{ marginBottom: 6 }}>
                {li.item.image_url && <img src={li.item.image_url} alt="" style={{ width: 44, height: 58, objectFit: 'cover', borderRadius: 6 }} />}
                <div className="grow">
                  {li.item.title ?? li.item.id} × {li.quantity}
                </div>
                <div>{formatMoney(li.totals?.find((t) => t.type === 'total')?.amount ?? li.item.price, cur)}</div>
              </div>
            ))}

            <h3>Özet</h3>
            <table className="totals">
              <tbody>
                {/* Render in the merchant's order, merchant labels; never recompute. */}
                {a.totals.map((t, i) => (
                  <tr key={`${t.type}-${i}`} className={t.type === 'total' ? 'total' : ''}>
                    <td>{t.display_text ?? t.type}</td>
                    <td>{formatMoney(t.amount, cur)}</td>
                  </tr>
                ))}
                {!a.shipping.present && (
                  <tr>
                    <td>Kargo</td>
                    <td className="muted">{a.shipping.text}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {a.totalsMismatch && (
              <div className="notice warn small">Kalemlerin toplamı “total” ile tutmuyor — mağaza sayfasında kontrol edin.</div>
            )}
          </div>

          {a.shippingChoices.length > 0 && (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Kargo seçenekleri</h2>
              {a.shippingChoices.map((g) => (
                <div key={g.groupId}>
                  {g.options.map((o) => (
                    <label key={o.id} className={`option ${g.selectedOptionId === o.id ? 'on' : ''}`} style={{ color: 'inherit' }}>
                      <input
                        type="radio"
                        name={g.groupId}
                        checked={g.selectedOptionId === o.id}
                        disabled={busy}
                        onChange={() => void update({ selectOption: { groupId: g.groupId, optionId: o.id } })}
                      />
                      <span className="grow">
                        <strong>{o.title ?? o.id}</strong>
                        {o.estimate && <div className="small muted">Tahmini teslim: {o.estimate}</div>}
                        {o.carrier && <div className="small muted">{o.carrier}</div>}
                      </span>
                      <span>{o.amount !== undefined ? formatMoney(o.amount, cur) : ''}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <h2 style={{ marginTop: 0 }}>İndirim kodu</h2>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault()
                void update({ discountCodes: code ? [code] : [] })
              }}
            >
              <input className="grow" value={code} onChange={(e) => setCode(e.target.value)} placeholder="affiliate kuponu" />
              <button disabled={busy}>Uygula</button>
              {view.discountCodes.length > 0 && (
                <button type="button" disabled={busy} onClick={() => void update({ discountCodes: [] })}>
                  Temizle
                </button>
              )}
            </form>
            <div className="small" style={{ marginTop: 6 }}>
              Gönderilen: {view.discountCodes.join(', ') || '—'} · Mağazanın yansıttığı: {a.discountCodesEchoed.join(', ') || '—'}
            </div>
            {a.discountsApplied.map((d, i) => (
              <div key={i} className="notice ok small">
                Uygulandı: {String(d.title ?? d.code ?? '')} {typeof d.amount === 'number' ? `(−${formatMoney(d.amount, cur)})` : ''}
                {d.automatic ? ' · otomatik' : ''}
              </div>
            ))}
            {view.discountCodes.length > 0 && a.discountsApplied.length === 0 && (
              <div className="notice warn small">Kod uygulanmadı. Mağaza mesajları yukarıda (varsa) gösteriliyor.</div>
            )}
          </div>

          {a.links.length > 0 && (
            <div className="card small">
              <h2 style={{ marginTop: 0 }}>Mağaza politikaları</h2>
              <div className="row">
                {a.links.map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
                    {l.title ?? l.type}
                  </a>
                ))}
              </div>
            </div>
          )}

          {view.continueUrl ? (
            <PaymentLauncher
              key={view.continueUrl}
              seller={seller}
              continueUrl={view.continueUrl}
              ucpVersion={typeof view.ucp?.version === 'string' ? view.ucp.version : undefined}
              scenario={scenario}
              onClosed={() => {
                setClosedOnce(true)
                void checkStatus()
              }}
            />
          ) : (
            <div className="notice warn">Mağaza continue_url döndürmedi.</div>
          )}

          <div className="card">
            <div className="row">
              <button onClick={() => void checkStatus()} disabled={busy}>
                Durumu kontrol et
              </button>
              {closedOnce && <span className="small muted">Ödeme penceresi kapandı; durum otomatik sorgulandı.</span>}
              {statusMsg && <span className="small muted">{statusMsg}</span>}
            </div>
            {a.completed ? (
              <div className="notice ok" style={{ marginTop: 8 }}>
                Sipariş tamamlanmış görünüyor. <Link href={`/confirmation?seller=${encodeURIComponent(seller)}`}>Kauna onay ekranı →</Link>
              </div>
            ) : (
              <p className="small muted">completed değil (durum: {a.status}). Bu prototipte beklenen budur.</p>
            )}
          </div>

          <details className="card small">
            <summary>Teknik ayrıntılar</summary>
            <div>
              Telefon alanı (canlı şemadan): <span className="mono">{view.phonePlacement}</span>
            </div>
            {view.phoneCandidates && (
              <div className="mono">
                {Object.entries(view.phoneCandidates).map(([k, v]) => (
                  <div key={k}>
                    {k}: {v}
                  </div>
                ))}
              </div>
            )}
            <div>
              continue_url (UTM’li): <span className="mono">{view.continueUrl}</span>
            </div>
            {view.buildNotes.map((n) => (
              <div key={n}>• {n}</div>
            ))}
            <pre>{JSON.stringify(view.ucp?.payment_handlers ?? null, null, 2)}</pre>
          </details>
        </>
      )}
    </>
  )
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<p className="muted">Yükleniyor…</p>}>
      <CheckoutInner />
    </Suspense>
  )
}
