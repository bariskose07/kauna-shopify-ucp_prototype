// Fallback transport (path 3): run @shopify/ucp-cli with `--format json`.
// Enabled with UCP_TRANSPORT=cli. The CLI does its own discovery,
// negotiation and client-side schema validation; we only translate
// tool name + wire args ↔ CLI command + body.
//
// There is intentionally no mapping for `complete_checkout` (rule 1); the
// FORBIDDEN_TOOLS check in client.ts runs before this module is reached anyway.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { maskPII } from '../mask'
import type { CallResult, Discovered } from './client'
import { UcpError } from './errors'
import type { Json } from './types'

const run = promisify(execFile)

type BodyKey = 'catalog' | 'cart' | 'checkout'

// tool → [cli words, body key, where the id lives]
const COMMANDS: Record<string, { words: string[]; body?: BodyKey; id?: 'top' | 'catalog' }> = {
  search_catalog: { words: ['catalog', 'search'], body: 'catalog' },
  lookup_catalog: { words: ['catalog', 'lookup'], body: 'catalog' },
  get_product: { words: ['catalog', 'get_product'], body: 'catalog', id: 'catalog' },
  create_cart: { words: ['cart', 'create'], body: 'cart' },
  get_cart: { words: ['cart', 'get'], id: 'top' },
  update_cart: { words: ['cart', 'update'], body: 'cart', id: 'top' },
  create_checkout: { words: ['checkout', 'create'], body: 'checkout' },
  get_checkout: { words: ['checkout', 'get'], id: 'top' },
  update_checkout: { words: ['checkout', 'update'], body: 'checkout', id: 'top' },
}

function bin() {
  return process.env.UCP_CLI_BIN || 'ucp'
}

async function ucp(args: string[]): Promise<Json> {
  try {
    const { stdout } = await run(bin(), [...args, '--format', 'json'], {
      env: process.env,
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
    })
    return JSON.parse(stdout) as Json
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string }
    // The CLI prints a flat {code, message} error on stdout and exits 1.
    let parsed: Json | undefined
    try {
      parsed = err.stdout ? (JSON.parse(err.stdout) as Json) : undefined
    } catch {
      parsed = undefined
    }
    const code = String(parsed?.code ?? 'CLI_FAILED')
    throw new UcpError({
      kind: code === 'RATE_LIMITED' ? 'rate_limited' : code === 'OPERATION_NOT_OFFERED' ? 'not_offered' : 'cli',
      message: `ucp ${args.slice(0, 2).join(' ')}: ${String(parsed?.message ?? err.stderr ?? err.message)}`,
      data: parsed,
    })
  }
}

export async function callToolViaCli<T>(business: string, toolName: string, wireArgs: Json): Promise<CallResult<T>> {
  const cmd = COMMANDS[toolName]
  if (!cmd) throw new UcpError({ kind: 'not_offered', message: `CLI adaptöründe ${toolName} eşlemesi yok.` })

  const args = [...cmd.words]
  let body: Json = cmd.body ? { ...((wireArgs[cmd.body] as Json) ?? {}) } : {}
  if (cmd.id === 'top') args.push(String(wireArgs.id))
  if (cmd.id === 'catalog') {
    args.push(String(body.id))
    const { id: _id, ...rest } = body
    body = rest
  }
  // Global catalog ops omit --business (the CLI routes to catalog.shopify.com).
  const isGlobalCatalog = cmd.body === 'catalog' && /catalog\.shopify\.com/.test(business)
  if (!isGlobalCatalog) args.push('--business', business)
  if (Object.keys(body).length > 0) args.push('--input', JSON.stringify(body))

  const started = Date.now()
  const env = await ucp(args)
  // Default JSON output: { business, endpoint, transport, ucp, result, cta }.
  const result = (env.result ?? env) as Json
  const data = { ucp: env.ucp, ...result } as Json
  const discovered: Discovered = {
    business,
    version: String((env.ucp as Json | undefined)?.version ?? ''),
    source: 'well-known',
    businessProfileUrl: `${business}/.well-known/ucp`,
    endpoint: String(env.endpoint ?? ''),
    agentProfileUrl: process.env.UCP_AGENT_PROFILE_URL ?? '(ucp-cli managed profile)',
    capabilities: (env.ucp as Json | undefined)?.capabilities,
    paymentHandlers: (env.ucp as Json | undefined)?.payment_handlers,
    profile: {},
  }
  return {
    data: data as T,
    ucp: env.ucp as CallResult['ucp'],
    isError: false,
    discovered,
    trace: {
      tool: toolName,
      business,
      endpoint: discovered.endpoint,
      durationMs: Date.now() - started,
      request: maskPII({ cli: ['ucp', ...args.map((a) => (a.startsWith('{') ? '<json>' : a))], body }),
      response: maskPII(data),
    },
  }
}

/** `ucp <op> --input-schema` returns the CLI-facing (unwrapped) body schema; re-wrap it. */
export async function inputSchemaViaCli(business: string, toolName: string): Promise<unknown> {
  const cmd = COMMANDS[toolName]
  if (!cmd) throw new UcpError({ kind: 'not_offered', message: `CLI adaptöründe ${toolName} eşlemesi yok.` })
  const env = await ucp([...cmd.words, '--input-schema', '--business', business])
  const schema = (env.result ?? env.inputSchema ?? env) as Json
  if (!cmd.body) return schema
  return {
    type: 'object',
    properties: { [cmd.body]: schema, ...(cmd.id === 'top' ? { id: { type: 'string' } } : {}) },
  }
}
