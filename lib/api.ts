// Shared helpers for route handlers: logging UCP calls into the session and
// turning errors into consistent JSON responses.

import { NextResponse } from 'next/server'

import { pushLog, type Session } from './session'
import type { CallResult, CallTrace } from './ucp/client'
import { UcpError, isUcpError } from './ucp/errors'

const HINTS: Record<string, string> = {
  jsonrpc: 'Protokol hatası (JSON-RPC error). İstek işlenmedi; checkout değişmedi.',
  http: 'Mağaza uç noktası beklenmeyen bir HTTP yanıtı verdi.',
  rate_limited: 'Hız limiti. Retry-After süresi kadar bekleyip tekrar deneyin.',
  network: 'Ağ hatası (DNS/TLS/zaman aşımı).',
  discovery: 'Mağazanın /.well-known/ucp profili okunamadı veya kullanılamaz.',
  not_offered: 'Mağaza bu işlemi sunmuyor.',
  schema: 'Ön kontrol: istek, mağazanın canlı şemasına uymadığı için GÖNDERİLMEDİ.',
  forbidden: 'Prototip güvenlik kuralı.',
  auth: "Kimlik doğrulama: token alınamadı ya da mağaza token'ı reddetti (AuthenticationFailed). İstek token'sız tekrarlanmadı; bu yalnızca Ayarlar → \"Token reddedilirse token'sız dene (yalnızca test)\" ile açılır.",
  cli: 'UCP CLI adaptörü hata verdi.',
}

export function traceFromError(e: unknown): CallTrace | undefined {
  if (!isUcpError(e) || !e.details || typeof e.details !== 'object') return undefined
  return (e.details as { trace?: CallTrace }).trace
}

/** Run a UCP call and record it (masked) in the session debug log. */
export async function logged<T>(
  s: Session,
  seller: string | undefined,
  fn: () => Promise<CallResult<T>>,
  opts: { catalog?: boolean } = {},
): Promise<CallResult<T>> {
  try {
    const r = await fn()
    pushLog(s, {
      seller,
      tool: r.trace.tool,
      endpoint: r.trace.endpoint,
      auth: r.trace.auth,
      surface: r.trace.surface,
      profile: r.trace.profile,
      payloadSource: r.trace.payloadSource,
      durationMs: r.trace.durationMs,
      request: r.trace.request,
      // Rule 3: catalog responses are not kept on the server.
      response: opts.catalog ? '[Catalog yanıtı sunucuda saklanmaz — istemci panelinde gösterilir]' : r.trace.response,
      raw: opts.catalog ? undefined : r.trace.raw,
      validation: r.trace.validation,
    })
    return r
  } catch (e) {
    const t = traceFromError(e)
    pushLog(s, {
      seller,
      tool: t?.tool ?? 'unknown',
      endpoint: t?.endpoint,
      auth: t?.auth,
      surface: t?.surface,
      profile: t?.profile,
      durationMs: t?.durationMs,
      request: t?.request,
      validation: t?.validation,
      error: isUcpError(e) ? { ...e.toJSON(), details: undefined } : { message: (e as Error).message },
    })
    throw e
  }
}

export function errorJson(e: unknown, extra: Record<string, unknown> = {}) {
  if (e instanceof UcpError) {
    const status =
      e.kind === 'schema' || e.kind === 'forbidden'
        ? 400
        : e.kind === 'rate_limited'
          ? 429
          : e.kind === 'not_offered'
            ? 404
            : e.kind === 'auth'
              ? 401
              : 502
    const headers: Record<string, string> = {}
    if (e.retryAfterSeconds !== undefined) headers['Retry-After'] = String(e.retryAfterSeconds)
    const details = e.details as { trace?: CallTrace; validation?: unknown } | undefined
    return NextResponse.json(
      {
        error: {
          kind: e.kind,
          message: e.message,
          hint: HINTS[e.kind],
          rpcCode: e.rpcCode,
          httpStatus: e.httpStatus,
          retryAfterSeconds: e.retryAfterSeconds,
          data: e.data,
          validation: details?.validation ?? details?.trace?.validation,
        },
        trace: details?.trace,
        ...extra,
      },
      { status, headers },
    )
  }
  const msg = e instanceof Error ? e.message : String(e)
  return NextResponse.json({ error: { kind: 'internal', message: msg }, ...extra }, { status: 500 })
}

export function badRequest(message: string) {
  return NextResponse.json({ error: { kind: 'bad_request', message } }, { status: 400 })
}
