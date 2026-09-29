// Live-schema helpers. Rule 4: never guess field names — every request body is
// checked against the inputSchema the business itself advertises in
// `tools/list` before it goes on the wire.
//
// Three jobs:
//   - findUnknownFields(): plain keys that the schema does not list. This is the
//     guard that would have caught `phone_number` being sent where the business
//     expected something else (it silently dropped the whole destination).
//   - pathStatus(): "does checkout.buyer.phone_number exist in this schema?" —
//     used to decide *where* the phone goes, which discount/attribution shape is
//     accepted, etc.
//   - validate(): full JSON-Schema validation with Ajv (draft 2020-12), when the
//     published schema compiles. Unresolvable external $refs → skipped, noted.

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

type Schema = Record<string, unknown> | boolean

// Reverse-DNS extension keys (e.g. `dev.ucp.buyer_ip`, `com.shopify.x`) are
// always allowed by UCP; mirror the ucp-cli policy.
const REVERSE_DNS = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Resolve a local JSON pointer `$ref` (`#/$defs/Foo`). External refs → undefined. */
function resolveRef(ref: string, root: Schema): Schema | undefined {
  if (!ref.startsWith('#')) return undefined
  const parts = ref
    .slice(1)
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p.replaceAll('~1', '/').replaceAll('~0', '~')))
  let cur: unknown = root
  for (const p of parts) {
    if (!isObj(cur)) return undefined
    cur = cur[p]
  }
  return isObj(cur) || typeof cur === 'boolean' ? (cur as Schema) : undefined
}

interface ObjectView {
  /** Known properties after merging allOf/anyOf/oneOf branches. */
  properties: Record<string, Schema>
  /** True when some branch could not be resolved → we cannot judge unknown keys. */
  opaque: boolean
  /** True when at least one branch declares a `properties` map. */
  hasProperties: boolean
  required: Set<string>
}

/** Flatten an object schema (following local $ref + compositions). */
export function objectView(schema: Schema | undefined, root: Schema, depth = 0): ObjectView {
  const view: ObjectView = { properties: {}, opaque: false, hasProperties: false, required: new Set() }
  if (schema === undefined || depth > 25) {
    view.opaque = true
    return view
  }
  if (typeof schema === 'boolean') {
    view.opaque = true
    return view
  }
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root)
    if (target === undefined) view.opaque = true
    else merge(view, objectView(target, root, depth + 1))
  }
  if (isObj(schema.properties)) {
    view.hasProperties = true
    for (const [k, v] of Object.entries(schema.properties)) {
      view.properties[k] = view.properties[k] ?? (v as Schema)
    }
  }
  if (Array.isArray(schema.required)) for (const r of schema.required) view.required.add(String(r))
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[key]
    if (!Array.isArray(branches)) continue
    for (const b of branches) {
      const sub = objectView(b as Schema, root, depth + 1)
      // Only allOf contributes `required` unconditionally.
      if (key !== 'allOf') sub.required.clear()
      merge(view, sub)
    }
  }
  // `additionalProperties: {schema}` / patternProperties → open map.
  if (isObj(schema.additionalProperties) || isObj(schema.patternProperties)) view.opaque = true
  return view
}

function merge(into: ObjectView, from: ObjectView) {
  into.opaque ||= from.opaque
  into.hasProperties ||= from.hasProperties
  for (const [k, v] of Object.entries(from.properties)) into.properties[k] = into.properties[k] ?? v
  for (const r of from.required) into.required.add(r)
}

/** Items schema of an array schema (following $ref / compositions). */
function itemsOf(schema: Schema | undefined, root: Schema, depth = 0): Schema | undefined {
  if (!isObj(schema) || depth > 25) return undefined
  if (schema.items !== undefined) return schema.items as Schema
  if (typeof schema.$ref === 'string') return itemsOf(resolveRef(schema.$ref, root), root, depth + 1)
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[key]
    if (!Array.isArray(branches)) continue
    for (const b of branches) {
      const it = itemsOf(b as Schema, root, depth + 1)
      if (it !== undefined) return it
    }
  }
  return undefined
}

export interface UnknownField {
  /** JSON pointer of the offending key, e.g. /checkout/buyer/phone_number */
  pointer: string
  /** Keys the schema does list at that level (helps fix the payload). */
  allowed: string[]
}

/** Keys in `value` not listed by `schema` (reverse-DNS extension keys allowed). */
export function findUnknownFields(
  schema: Schema,
  value: unknown,
  root: Schema = schema,
  pointer = '',
): UnknownField[] {
  if (Array.isArray(value)) {
    const items = itemsOf(schema, root)
    if (items === undefined) return []
    return value.flatMap((v, i) => findUnknownFields(items, v, root, `${pointer}/${i}`))
  }
  if (!isObj(value)) return []
  const view = objectView(schema, root)
  if (!view.hasProperties) return []
  const out: UnknownField[] = []
  for (const [k, v] of Object.entries(value)) {
    const child = view.properties[k]
    if (child === undefined) {
      // `meta` is protocol-owned (ucp-agent, idempotency-key) and often not
      // listed; everything else must be listed or be a reverse-DNS extension.
      if (pointer === '' && k === 'meta') continue
      if (REVERSE_DNS.test(k)) continue
      if (view.opaque) continue
      out.push({ pointer: `${pointer}/${escape(k)}`, allowed: Object.keys(view.properties).sort() })
      continue
    }
    out.push(...findUnknownFields(child, v, root, `${pointer}/${escape(k)}`))
  }
  return out
}

function escape(k: string) {
  return k.replaceAll('~', '~0').replaceAll('/', '~1')
}

export type PathStatus = 'present' | 'absent' | 'unknown'

/**
 * Does a dotted path exist in the schema? `[]` descends into array items:
 *   pathStatus(schema, 'checkout.fulfillment.methods[].destinations[].phone_number')
 * 'unknown' means an unresolvable branch (external $ref / open map) was hit.
 */
export function pathStatus(schema: Schema, path: string, root: Schema = schema): PathStatus {
  let cur: Schema | undefined = schema
  for (const raw of path.split('.')) {
    const isArray = raw.endsWith('[]')
    const key = isArray ? raw.slice(0, -2) : raw
    const view = objectView(cur, root)
    const next: Schema | undefined = view.properties[key]
    if (next === undefined) return view.opaque || !view.hasProperties ? 'unknown' : 'absent'
    cur = isArray ? itemsOf(next, root) : next
    if (cur === undefined) return 'unknown'
  }
  return 'present'
}

/** Sub-schema at a dotted path (same syntax as pathStatus), or undefined. */
export function schemaAt(schema: Schema, path: string, root: Schema = schema): Schema | undefined {
  let cur: Schema | undefined = schema
  for (const raw of path.split('.')) {
    const isArray = raw.endsWith('[]')
    const key = isArray ? raw.slice(0, -2) : raw
    const next: Schema | undefined = objectView(cur, root).properties[key]
    if (next === undefined) return undefined
    cur = isArray ? itemsOf(next, root) : next
  }
  return cur
}

/** Listed property names of the object at `path` ('' = root). */
export function propertiesAt(schema: Schema, path: string): { keys: string[]; opaque: boolean } {
  const node = path === '' ? schema : schemaAt(schema, path)
  const view = objectView(node, schema)
  return { keys: Object.keys(view.properties).sort(), opaque: view.opaque || !view.hasProperties }
}

/** Required keys of the object at `path`. */
export function requiredAt(schema: Schema, path: string): string[] {
  const node = path === '' ? schema : schemaAt(schema, path)
  return [...objectView(node, schema).required].sort()
}

export interface ValidationReport {
  compiled: boolean
  valid: boolean | null
  errors: string[]
  unknownFields: UnknownField[]
  note?: string
}

const ajvCache = new WeakMap<object, ReturnType<Ajv2020['compile']> | Error>()

/** Full validation: Ajv (when it compiles) + closed-key policy. */
export function validate(schema: unknown, value: unknown): ValidationReport {
  if (!isObj(schema)) {
    return { compiled: false, valid: null, errors: [], unknownFields: [], note: 'inputSchema yok' }
  }
  const unknownFields = findUnknownFields(schema, value)
  let fn = ajvCache.get(schema)
  if (fn === undefined) {
    try {
      const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
      addFormats(ajv)
      fn = ajv.compile(schema)
    } catch (e) {
      fn = e as Error
    }
    ajvCache.set(schema, fn)
  }
  if (fn instanceof Error) {
    return {
      compiled: false,
      valid: null,
      errors: [],
      unknownFields,
      note: `Şema derlenemedi (muhtemelen harici $ref): ${fn.message}. Sunucu doğrulayacak.`,
    }
  }
  const ok = fn(value) as boolean
  return {
    compiled: true,
    valid: ok,
    errors: ok
      ? []
      : (fn.errors ?? []).slice(0, 8).map((e) => `${e.instancePath || '<root>'} ${e.message ?? e.keyword}`),
    unknownFields,
  }
}
