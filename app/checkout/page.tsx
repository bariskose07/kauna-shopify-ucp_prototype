'use client'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Fragment, Suspense, useCallback, useEffect, useState } from 'react'

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
        setCode(r.draft.discountCodes?.[0] ?? '')
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
  const cancel = async () => {
    if (!window.confirm('Checkout mağazada iptal edilsin mi (cancel_checkout)?')) return
    await call(() => api<View>('/api/checkout/cancel', { body: { seller } }))
    setStatusMsg(`cancel_checkout gönderildi: ${new Date().toLocaleTimeString()}`)
  }

  if (!seller)
    return (
      <div className="empty">
        Satıcı belirtilmedi. <Link href="/cart">Sepete dön</Link>
      </div>
    )

  const a = view?.analysis
  const co = view?.checkout
  const cur = co?.currency ?? a?.currency
  const host = new URL(seller).host
  const step = !view?.checkoutId ? 1 : a?.completed ? 4 : closedOnce ? 3 : 2
  const statusTone =
    a?.status === 'ready_for_complete' || a?.status === 'completed'
      ? 'ok'
      : a?.status === 'requires_escalation' || a?.status === 'incomplete'
        ? 'warn'
        : 'danger'

  const summary = view?.checkoutId && a && (
    <aside className="sticky-summary">
      <div className="card">
        <div className="status-head">
          <h2 style={{ margin: 0 }} className="grow">
            Sipariş özeti
          </h2>
          <span className={`badge ${statusTone}`}>{a.status}</span>
        </div>
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          {host} · Kauna no {view.draftOrderId}
        </p>
        {(co?.line_items ?? []).map((li) => (
          <div key={li.id} className="line-item small">
            {li.item.image_url ? <img src={li.item.image_url} alt="" /> : <div className="ph" />}
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{li.item.title ?? li.item.id}</div>
              <div className="muted">Adet: {li.quantity}</div>
            </div>
            <div>{formatMoney(li.totals?.find((t) => t.type === 'total')?.amount ?? li.item.price, cur)}</div>
          </div>
        ))}
        <table className="totals" style={{ marginTop: 6 }}>
          <tbody>
            {/* Merchant's order and labels; never recomputed. */}
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
        {a.links.length > 0 && (
          <div className="row small" style={{ marginTop: 12, gap: 12 }}>
            {a.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
                {l.title ?? l.type}
              </a>
            ))}
          </div>
        )}
      </div>
    </aside>
  )

  return (
    <>
      <h1>Ödeme · {host}</h1>
      <ol className="stepper" aria-label="Adımlar">
        {['Bilgiler', 'Özet', 'Mağazada ödeme', 'Onay'].map((label, i) => (
          <li key={label} className={i + 1 < step ? 'done' : i + 1 === step ? 'current' : ''}>
            <span className="dot">{i + 1 < step ? '✓' : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {error && <ErrorBox e={error} />}

      <div className={view?.checkoutId ? 'layout-2col' : ''}>
        <div>
          {view?.checkoutId && a && (
            <>
              {a.silentFailures.map((s) => (
                <div key={s} className="notice danger small">
                  <strong>Sessiz hata şüphesi</strong>
                  {s}
                </div>
              ))}
              {a.unrecoverable.map((m, i) => (
                <div key={i} className="notice danger small">
                  <strong>Bu checkout kullanılamaz</strong>
                  {m.code}: {m.content} — yeni checkout başlatın.
                </div>
              ))}
              {a.missingFields.map((m, i) => (
                <MissingFieldForm
                  key={`${m.code}-${i}`}
                  m={m}
                  busy={busy}
                  onSubmit={(field, value) => {
                    setBuyer({ ...buyer, [field]: value })
                    if (field === 'phone') setIncludePhone(true)
                    void update({ buyer: { [field]: value }, includePhone: field === 'phone' ? true : includePhone })
                  }}
                />
              ))}
              {a.handoff.required && (
                <div className="notice warn">
                  <strong>Bu mağaza ödemenin kendi sayfasında tamamlanmasını istiyor.</strong>
                  <span className="small">
                    Aşağıdan mağazanın ödeme sayfasını açın; bilgileriniz dolu gelir.{' '}
                    <span className="muted">({a.handoff.reason})</span>
                  </span>
                </div>
              )}
              {[...a.buyerInput, ...a.buyerReview].map((m, i) => (
                <div key={i} className="notice small">
                  <span className="mono">{m.code}</span> ({m.severity}): {m.content}
                </div>
              ))}
              {a.warnings.map((m, i) => (
                <div key={i} className="notice warn small">
                  {m.presentation === 'disclosure' ? <strong>Bildirim</strong> : null}
                  {m.content}{' '}
                  {m.url && (
                    <a href={m.url} target="_blank" rel="noreferrer">
                      Ayrıntı
                    </a>
                  )}
                </div>
              ))}
              {a.infos.map((m, i) => (
                <div key={i} className="notice small">
                  {m.content}
                </div>
              ))}

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

              {a.shippingChoices.length > 0 && (
                <div className="card">
                  <h2>Kargo</h2>
                  {a.shippingChoices.map((g) => (
                    <div key={g.groupId}>
                      {g.options.map((o) => (
                        <label key={o.id} className={`option ${g.selectedOptionId === o.id ? 'on' : ''}`}>
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
                <h2>İndirim kodu</h2>
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void update({ discountCodes: code.trim() ? [code.trim()] : [] })
                  }}
                >
                  <input className="grow" value={code} onChange={(e) => setCode(e.target.value)} placeholder="affiliate kuponu" />
                  <button disabled={busy}>Uygula</button>
                  {view.discountCodes.length > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setCode('')
                        void update({ discountCodes: [] })
                      }}
                    >
                      Temizle
                    </button>
                  )}
                </form>
                <div className="small muted" style={{ marginTop: 8 }}>
                  Gönderilen: {view.discountCodes.join(', ') || '—'} · Mağazanın yansıttığı: {a.discountCodesEchoed.join(', ') || '—'}
                </div>
                {a.discountsApplied.map((d, i) => (
                  <div key={i} className="notice ok small">
                    Uygulandı: {String(d.title ?? d.code ?? '')}{' '}
                    {typeof d.amount === 'number' ? `(−${formatMoney(Math.abs(d.amount), cur)})` : ''}
                    {d.automatic ? ' · otomatik' : ''}
                  </div>
                ))}
                {view.discountCodes.length > 0 && a.discountsApplied.length === 0 && (
                  <div className="notice warn small">Kod uygulanmadı. Mağazanın mesajı (varsa) yukarıda.</div>
                )}
              </div>

              <div className="card">
                <div className="row">
                  <button onClick={() => void checkStatus()} disabled={busy}>
                    Durumu kontrol et
                  </button>
                  <button onClick={() => void cancel()} disabled={busy}>
                    Checkout'u iptal et
                  </button>
                  <span className="small muted grow">
                    {closedOnce ? 'Ödeme penceresi kapandı; durum otomatik sorgulandı. ' : ''}
                    {statusMsg}
                  </span>
                </div>
                {a.completed ? (
                  <div className="notice ok">
                    <strong>Sipariş tamamlanmış görünüyor.</strong>
                    <Link href={`/confirmation?seller=${encodeURIComponent(seller)}`}>Kauna onay ekranı →</Link>
                  </div>
                ) : (
                  <p className="small muted" style={{ marginBottom: 0 }}>
                    Durum: {a.status} (tamamlanmadı — bu prototipte beklenen budur).
                  </p>
                )}
              </div>
            </>
          )}

          <details className="card" open={!view?.checkoutId}>
            <summary>{view?.checkoutId ? 'Alıcı bilgileri ve test seçenekleri' : 'Alıcı bilgileri'}</summary>
            <p className="small muted" style={{ marginTop: 6 }}>
              Yalnızca sunucu belleğinde tutulur; kart bilgisi hiç istenmez.
            </p>
            <div className="grid2" style={{ marginTop: 10 }}>
              {(Object.keys(FIELD_LABELS) as (keyof BuyerInfo)[]).map((k) => (
                <div key={k} className="field">
                  <label htmlFor={`f-${k}`}>{FIELD_LABELS[k]}</label>
                  <input
                    id={`f-${k}`}
                    value={buyer[k]}
                    onChange={(e) => setBuyer({ ...buyer, [k]: e.target.value })}
                    disabled={k === 'address_country'}
                    inputMode={k === 'phone' ? 'tel' : k === 'email' ? 'email' : undefined}
                    autoComplete={
                      { email: 'email', first_name: 'given-name', last_name: 'family-name', street_address: 'street-address', address_locality: 'address-level2', address_region: 'address-level1', postal_code: 'postal-code', address_country: 'country', phone: 'tel' }[k]
                    }
                  />
                </div>
              ))}
            </div>
            {!view?.checkoutId && (
              <div className="field">
                <label htmlFor="f-code">İndirim kodu (isteğe bağlı)</label>
                <input id="f-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ör. KAUNA10" />
              </div>
            )}
            <div className="grid2" style={{ marginTop: 4 }}>
              <div className="field">
                <label htmlFor="f-scenario">Test senaryosu (bulgu etiketi)</label>
                <select id="f-scenario" value={scenario} onChange={(e) => setScenario(e.target.value)}>
                  <option value="">—</option>
                  {SCENARIOS.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      {sc.id}. {sc.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Seçenekler</label>
                <label className="check">
                  <input type="checkbox" checked={includePhone} onChange={(e) => setIncludePhone(e.target.checked)} /> Telefonu gönder
                </label>
                <label className="check">
                  <input type="checkbox" checked={injectWrongField} onChange={(e) => setInjectWrongField(e.target.checked)} /> Senaryo
                  5: yanlış alan adı
                </label>
              </div>
            </div>
            <div className="row">
              {!view?.checkoutId ? (
                <button className="primary block" onClick={() => void create()} disabled={busy}>
                  {busy ? 'Oluşturuluyor…' : 'Devam et — özeti gör'}
                </button>
              ) : (
                <>
                  <button className="primary" onClick={() => void update({ buyer, includePhone })} disabled={busy}>
                    Bilgileri güncelle
                  </button>
                  <button onClick={() => void create()} disabled={busy}>
                    Yeni checkout
                  </button>
                </>
              )}
            </div>
          </details>

          {view?.checkoutId && (
            <details className="card small">
              <summary>Teknik ayrıntılar</summary>
              <dl className="info-list" style={{ marginTop: 10 }}>
                <dt>checkout</dt>
                <dd className="mono">{view.checkoutId}</dd>
                <dt>Telefon alanı</dt>
                <dd className="mono">{view.phonePlacement}</dd>
                {view.phoneCandidates &&
                  Object.entries(view.phoneCandidates).map(([k, v]) => (
                    <Fragment key={k}>
                      <dt className="mono">{k}</dt>
                      <dd>{v}</dd>
                    </Fragment>
                  ))}
                <dt>continue_url</dt>
                <dd className="mono">{view.continueUrl}</dd>
              </dl>
              {view.buildNotes.map((n) => (
                <div key={n}>• {n}</div>
              ))}
              <pre>{JSON.stringify(view.ucp?.payment_handlers ?? null, null, 2)}</pre>
            </details>
          )}
        </div>
        {summary}
      </div>
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
