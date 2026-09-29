'use client'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { ApiFailure, api, getClientLog, subscribeClientLog } from '@/lib/browser'
import type { DebugEntry, Observation } from '@/lib/session'
import { AAB_US } from '@/lib/scenarios'

interface Snapshot {
  seller: string
  checkoutId?: string
  draftOrderId: string
  status?: string
  messages: unknown[]
  continueUrl?: string
  ucp?: { version?: unknown; capabilities?: unknown; payment_handlers?: unknown }
  phonePlacement: string
  scenario?: string
  buildNotes?: string[]
}

export default function DebugPage() {
  const [data, setData] = useState<{ log: DebugEntry[]; checkouts: Snapshot[]; observations: Observation[] } | null>(null)
  const [disc, setDisc] = useState<unknown>(null)
  const [seller, setSeller] = useState(AAB_US)
  const [copied, setCopied] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const clientLog = useSyncExternalStore(subscribeClientLog, getClientLog, getClientLog)

  const refresh = () => void api<typeof data>('/api/debug').then(setData)
  useEffect(refresh, [])

  async function copyFindings() {
    const r = await api<{ markdown: string }>('/api/findings')
    try {
      await navigator.clipboard.writeText(r.markdown)
      setCopied('Markdown panoya kopyalandı.')
    } catch {
      setCopied(r.markdown) // clipboard blocked (http on phone) → show it
    }
  }

  async function runDiscover() {
    setErr(null)
    try {
      setDisc(await api(`/api/discover?seller=${encodeURIComponent(seller)}`))
    } catch (e) {
      setErr(e instanceof ApiFailure ? `${e.error.message} — ${e.error.hint ?? ''}` : String(e))
    }
  }

  return (
    <>
      <h1>Hata ayıklama</h1>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="primary" onClick={() => void copyFindings()}>
          Bulguları kopyala
        </button>
        <button onClick={refresh}>Yenile</button>
        <button
          onClick={() => {
            void api('/api/debug', { method: 'DELETE' }).then(refresh)
          }}
        >
          Günlüğü temizle
        </button>
      </div>
      {copied && (copied.startsWith('Markdown') ? <div className="notice ok small">{copied}</div> : <pre>{copied}</pre>)}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Mağaza keşfi (/.well-known/ucp + tools/list + şema)</h2>
        <div className="row">
          <input className="grow" value={seller} onChange={(e) => setSeller(e.target.value)} />
          <button onClick={() => void runDiscover()}>Keşfet</button>
        </div>
        {err && <div className="notice danger small">{err}</div>}
        {disc !== null && <pre>{JSON.stringify(disc, null, 2)}</pre>}
      </div>

      <h2>Checkout’lar</h2>
      {data?.checkouts.length === 0 && <p className="muted small">Henüz checkout yok.</p>}
      {data?.checkouts.map((c) => (
        <div key={c.seller} className="card small">
          <div className="row">
            <strong className="grow">{c.seller}</strong>
            <span className="badge">{c.status}</span>
          </div>
          <div className="mono">{c.checkoutId}</div>
          <div>
            Telefon alanı: <span className="mono">{c.phonePlacement}</span> · senaryo: {c.scenario ?? '—'}
          </div>
          <div>
            continue_url: <span className="mono">{c.continueUrl ?? '—'}</span>
          </div>
          <details>
            <summary>messages ({c.messages.length})</summary>
            <pre>{JSON.stringify(c.messages, null, 2)}</pre>
          </details>
          <details>
            <summary>ucp.payment_handlers</summary>
            <pre>{JSON.stringify(c.ucp?.payment_handlers ?? null, null, 2)}</pre>
          </details>
          <details>
            <summary>ucp.capabilities</summary>
            <pre>{JSON.stringify(c.ucp?.capabilities ?? null, null, 2)}</pre>
          </details>
          {c.buildNotes?.map((n) => (
            <div key={n} className="muted">
              • {n}
            </div>
          ))}
        </div>
      ))}

      <h2>UCP istekleri (sunucu, kişisel veriler maskeli)</h2>
      <div className="card small">
        {[...(data?.log ?? [])].reverse().map((e) => (
          <details key={e.id} className="log-entry">
            <summary>
              <span className="mono">{e.at.slice(11, 19)}</span> <strong>{e.tool}</strong>{' '}
              {e.seller && <span className="muted">{e.seller.replace('https://', '')}</span>}{' '}
              {e.durationMs !== undefined && <span className="muted">{e.durationMs} ms</span>}{' '}
              {e.error ? <span className="badge danger">hata</span> : null}
            </summary>
            {e.endpoint && <div className="mono">{e.endpoint}</div>}
            {e.notes?.map((n) => <div key={n}>{n}</div>)}
            <div>İstek:</div>
            <pre>{JSON.stringify(e.request ?? null, null, 2)}</pre>
            {e.validation ? (
              <>
                <div>Şema ön kontrolü:</div>
                <pre>{JSON.stringify(e.validation, null, 2)}</pre>
              </>
            ) : null}
            <div>{e.error ? 'Hata:' : 'Yanıt:'}</div>
            <pre>{JSON.stringify(e.error ?? e.response ?? null, null, 2)}</pre>
          </details>
        ))}
        {data?.log.length === 0 && <p className="muted">Kayıt yok.</p>}
      </div>

      <h2>Tarayıcı günlüğü (Catalog izleri + ödeme olayları)</h2>
      <div className="card small">
        <p className="muted">Catalog yanıtları kurallar gereği sunucuda tutulmaz; yalnızca bu sekmenin belleğinde durur.</p>
        {[...clientLog].reverse().map((e, i) => (
          <details key={i} className="log-entry">
            <summary>
              <span className="mono">{e.at.slice(11, 19)}</span> <strong>{e.tool}</strong>
            </summary>
            <pre>{JSON.stringify(e.payload, null, 2)}</pre>
          </details>
        ))}
      </div>

      <h2>Gözlemler</h2>
      <pre>{JSON.stringify(data?.observations ?? [], null, 2)}</pre>
    </>
  )
}
