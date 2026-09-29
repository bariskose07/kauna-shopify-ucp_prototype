// "Bulguları kopyala": fills the README scenario table with what this session
// actually observed. Observations are tagged with a scenario id in the UI.

import { SCENARIOS } from './scenarios'
import type { Observation, Session } from './session'

function cell(s: string) {
  return s.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function summarize(obs: Observation[]): string {
  if (obs.length === 0) return '_çalıştırılmadı_'
  return obs
    .slice(-3)
    .map((o) => {
      if (o.kind === 'payment_mode') return `mod ${o.mode}: ${o.outcome ?? '?'}${o.detail ? ` — ${o.detail}` : ''}`
      const parts = [
        `${new URL(o.seller).host}`,
        o.status ? `\`${o.status}\`` : undefined,
        o.messageCodes?.length ? `mesajlar: ${o.messageCodes.map((c) => `\`${c}\``).join(', ')}` : 'mesaj yok',
        o.shipping ? `kargo: ${o.shipping}` : undefined,
        o.discountCodes?.length ? `kodlar: ${o.discountCodes.join(',')}` : undefined,
        o.discountsApplied?.length ? `applied: ${o.discountsApplied.join(', ')}` : undefined,
        o.silentFailure ? '⚠ sessiz hata uyarısı' : undefined,
        o.detail,
      ]
      return parts.filter(Boolean).join('; ')
    })
    .join(' → ')
}

export function findingsMarkdown(s: Session): string {
  const lines: string[] = []
  lines.push(`## Kauna × Shopify UCP — test bulguları (${new Date().toISOString()})`, '')
  lines.push('| # | Senaryo | Satıcı | Varyant | Beklenen | Gözlenen |', '| --- | --- | --- | --- | --- | --- |')
  for (const sc of SCENARIOS) {
    const obs = s.observations.filter((o) => o.scenario === sc.id)
    let observed = summarize(obs)
    if (sc.id === '7') {
      const sellers = Object.values(s.checkouts).filter((c) => c.checkoutId)
      observed =
        sellers.length > 0
          ? `${sellers.length} ayrı checkout: ${sellers.map((c) => `${new URL(c.seller).host} (\`${c.last?.status ?? '?'}\`)`).join(', ')}`
          : observed
    }
    lines.push(`| ${sc.id} | ${cell(sc.title)} | ${cell(sc.seller)} | ${cell(sc.variant)} | ${cell(sc.expected)} | ${cell(observed)} |`)
  }
  lines.push('', '### Mağaza başına')
  for (const c of Object.values(s.checkouts)) {
    const ucp = c.last?.ucp ?? {}
    const handlers = ucp.payment_handlers && typeof ucp.payment_handlers === 'object' ? Object.keys(ucp.payment_handlers) : []
    const caps = ucp.capabilities && typeof ucp.capabilities === 'object' ? Object.keys(ucp.capabilities) : []
    lines.push(
      `- **${c.seller}** — checkout \`${c.checkoutId ?? '-'}\`, durum \`${c.last?.status ?? '-'}\`, UCP ${String(ucp.version ?? '?')}`,
      `  - payment_handlers: ${handlers.map((h) => `\`${h}\``).join(', ') || '-'}`,
      `  - capabilities: ${caps.map((h) => `\`${h}\``).join(', ') || '-'}`,
      `  - telefon alanı (şemadan): \`${c.phonePlacement}\``,
      `  - continue_url host: ${c.last?.continue_url ? new URL(c.last.continue_url).host : '-'}`,
      ...(c.buildNotes ?? []).map((n) => `  - not: ${n}`),
    )
  }
  const untagged = s.observations.filter((o) => !o.scenario)
  if (untagged.length) {
    lines.push('', '### Etiketsiz gözlemler (son 5)')
    for (const o of untagged.slice(-5)) lines.push(`- ${o.at} ${o.kind}: ${summarize([o])}`)
  }
  return lines.join('\n')
}
