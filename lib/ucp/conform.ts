// Make an outgoing body fit the business's live schema *visibly*: keys the
// schema does not list are removed and reported (never silently sent, never
// silently dropped). Used for optional/soft fields such as catalog `context`
// hints, where "the store doesn't accept it" is a normal answer.
// Hard fields (buyer, destination, line items) go through checkout.ts, which
// decides placement from the schema and fails loudly instead.

import { findUnknownFields, type UnknownField } from './schema'
import type { Json } from './types'

function removePointer(obj: Json, pointer: string) {
  const parts = pointer
    .split('/')
    .slice(1)
    .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'))
  let cur: unknown = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return
    cur = (cur as Record<string, unknown>)[parts[i]]
  }
  if (cur !== null && typeof cur === 'object') delete (cur as Record<string, unknown>)[parts[parts.length - 1]]
}

export function conformToSchema(schema: unknown, args: Json): { args: Json; dropped: UnknownField[] } {
  const copy = structuredClone(args)
  if (schema === null || typeof schema !== 'object') return { args: copy, dropped: [] }
  // `meta` is injected later by the client; exclude it from the check here.
  const dropped = findUnknownFields(schema as Json, copy)
  // Remove deepest first so parent removal doesn't hide child pointers.
  for (const u of [...dropped].sort((a, b) => b.pointer.length - a.pointer.length)) removePointer(copy, u.pointer)
  return { args: copy, dropped }
}
