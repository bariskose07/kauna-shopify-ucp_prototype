'use client'
import { useEffect, useState, useSyncExternalStore } from 'react'

import type { AuthStatusData } from '@/components/AuthStatus'
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

  const [auth, setAuth] = useState<AuthStatusData | null>(null)
  const refresh = () => {
    void api<typeof data>('/api/debug').then(setData)
    void api<AuthStatusData>('/api/auth-status').then(setAuth)
  }
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

      <h2>Kimlik doğrulama</h2>
      <div className="card small">
        {auth ? (
          <table className="totals">
            <tbody>
              <tr>
                <td>Token durumu</td>
                <td>
                  <b>{auth.token.status}</b>
                  {auth.token.credentialSource ? <span className="muted"> · {auth.token.credentialSource}</span> : null}
                  {auth.token.error ? <div className="bad-text">Token alınamadı: {auth.token.error.message}</div> : null}
                  {auth.token.warning ? <div className="muted">{auth.token.warning}</div> : null}
                </td>
              </tr>
              <tr>
                <td>Kapsamlar (scopes)</td>
                <td className="mono">{auth.token.scopes?.length ? auth.token.scopes.join(' ') : '—'}</td>
              </tr>
              <tr>
                <td>Bitiş (exp)</td>
                <td className="mono">
                  {auth.token.expiresAt ? `${new Date(auth.token.expiresAt).toLocaleString()} (${auth.token.expiresInMin} dk)` : '—'}
                </td>
              </tr>
              <tr>
                <td>Limitler (limits)</td>
                <td>
                  <pre style={{ margin: 0 }}>{auth.token.limits ? JSON.stringify(auth.token.limits, null, 2) : '—'}</pre>
                </td>
              </tr>
              <tr>
                <td>Son ret</td>
                <td>
                  {auth.token.rejected
                    ? `${new Date(auth.token.rejected.at).toLocaleTimeString()} · ${auth.token.rejected.host} · ${auth.token.rejected.tool}: ${auth.token.rejected.message}`
                    : '—'}
                </td>
              </tr>
              <tr>
                <td>Test ayarları</td>
                <td>
                  token’sız yedek: <b>{auth.settings.tokenlessFallback ? 'AÇIK' : 'kapalı'}</b> · CLI:{' '}
                  <b>{auth.settings.cliTransport ? 'AÇIK' : 'kapalı'}</b>
                </td>
              </tr>
              <tr>
                <td>Yüzeyler</td>
                <td>
                  {auth.surfaces.map((x) => (
                    <div key={x.surface}>
                      {x.label}: <b>{x.expectedLabel}</b>
                      {x.blocked ? ' — gönderilmeyecek' : ''}
                    </div>
                  ))}
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          '…'
        )}
        <p className="muted">Token’ın kendisi hiçbir yerde gösterilmez; yalnızca içindeki kapsam, bitiş ve limit bilgileri okunur.</p>
      </div>

      <h2>UCP istekleri (sunucu, kişisel veriler maskeli)</h2>
      <div className="card small">
        {[...(data?.log ?? [])].reverse().map((e) => (
          <details key={e.id} className="log-entry">
            <summary>
              <span className="mono">{e.at.slice(11, 19)}</span> <strong>{e.tool}</strong>{' '}
              {e.seller && <span className="muted">{e.seller.replace('https://', '')}</span>}{' '}
              {e.durationMs !== undefined && <span className="muted">{e.durationMs} ms</span>}{' '}
              {e.auth && (
                <span
                  className={`badge ${e.auth.mode === 'token' ? 'ok' : e.auth.mode === 'fallback' ? 'warn' : ''}`}
                  title={e.auth.note ?? ''}
                >
                  {e.auth.mode === 'fallback' ? '⚠ ' : ''}
                  {e.auth.label ?? e.auth.mode}
                </span>
              )}{' '}
              {e.error ? <span className="badge danger">hata</span> : null}
            </summary>
            {e.endpoint && <div className="mono">{e.endpoint}</div>}
            {e.auth && (
              <div>
                Kimlik yolu: <b>{e.auth.label ?? e.auth.mode}</b>
                {e.surface ? ` · yüzey: ${e.surface}` : ''}
                {e.auth.note ? ` · ${e.auth.note}` : ''}
              </div>
            )}
            {(e.profile ?? e.auth?.profile) && (
              <div>
                Profil: <span className="mono">{e.profile ?? e.auth?.profile}</span>
              </div>
            )}
            {e.auth?.mode === 'token' && (
              <div>
                Token kapsamları: <span className="mono">{e.auth.tokenScopes?.join(' ') || '—'}</span>
                {e.auth.tokenExpiresAt ? ` · bitiş ${new Date(e.auth.tokenExpiresAt).toLocaleTimeString()}` : ''}
              </div>
            )}
            {e.payloadSource && <div>Yanıt kaynağı: {e.payloadSource}</div>}
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
            {e.raw ? (
              <details>
                <summary>Ham MCP yanıtı (maskeli)</summary>
                <pre>{JSON.stringify(e.raw, null, 2)}</pre>
              </details>
            ) : null}
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
