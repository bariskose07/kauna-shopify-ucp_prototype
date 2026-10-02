// Checkout MCP: create → update (full replace) → get. NEVER complete.
//
// update_checkout is PUT-like: any field not sent (line_items, buyer,
// fulfillment, discounts, attribution …) is cleared. So every update is
// rebuilt from the whole draft + the last response, by buildCheckoutBody().
//
// Where each value goes is read from the live schema (schemaFacts) instead of
// being hard-coded — e.g. the phone may live on the delivery destination or on
// the buyer depending on the business.

import type { CartState, CheckoutDraft, PhonePlacement } from '../session'
import { toRequestLines } from './cart'
import { pathStatus, propertiesAt, requiredAt } from './schema'
import type { CommerceObject, Json } from './types'

export const ATTRIBUTION = {
  referring_domain: 'kauna.ai',
  utm_source: 'kauna',
  utm_medium: 'agentic_commerce',
  utm_campaign: 'in_app_checkout',
} as const

// Candidate keys for the Kauna draft-order id, in preference order.
const EVENT_ID_KEYS = ['event_id', 'utm_id', 'click_id', 'external_id', 'utm_content']

// Phone candidates, most specific first. Shopify's recoverable message is
// `delivery_phone_number_required`, i.e. the *delivery* phone, so the
// destination wins when both exist.
const PHONE_CANDIDATES: Exclude<PhonePlacement, 'none'>[] = [
  'fulfillment.methods[].destinations[].phone_number',
  'buyer.phone_number',
  'fulfillment.methods[].destinations[].phone',
  'buyer.phone',
]

const BUYER_FIELDS = ['email', 'first_name', 'last_name'] as const
const DEST_FIELDS = [
  'first_name',
  'last_name',
  'street_address',
  'address_locality',
  'address_region',
  'postal_code',
  'address_country',
] as const

export interface SchemaFacts {
  op: 'create' | 'update'
  phonePlacement: PhonePlacement
  phoneCandidates: Record<string, string>
  buyerKeys: string[]
  buyerOpaque: boolean
  destinationKeys: string[]
  destinationOpaque: boolean
  /** Keys of a nested `destinations[].address` object, when the schema has one. */
  destinationAddressKeys: string[]
  supportsFulfillment: boolean
  supportsLineItemIds: boolean
  supportsGroups: boolean
  supportsMethodId: boolean
  supportsDiscounts: boolean
  /**
   * Where discount codes go, read from the schema. UCP core uses
   * `discounts.codes`; ucp-cli's extension hint mentions `discount_codes[]`.
   */
  discountShape: 'discounts.codes' | 'discount_codes' | 'none'
  attribution: { supported: boolean; keys: string[]; open: boolean }
  supportsContext: boolean
  supportsCartId: boolean
  methodRequired: string[]
}

/** Read the facts we need out of create_checkout / update_checkout inputSchema. */
export function schemaFacts(schema: unknown, op: 'create' | 'update'): SchemaFacts {
  const s = (schema ?? {}) as Json
  const has = (p: string) => pathStatus(s, `checkout.${p}`) === 'present'
  const phoneCandidates: Record<string, string> = {}
  for (const c of PHONE_CANDIDATES) phoneCandidates[c] = pathStatus(s, `checkout.${c}`)
  const phonePlacement = PHONE_CANDIDATES.find((c) => phoneCandidates[c] === 'present') ?? 'none'
  const buyer = propertiesAt(s, 'checkout.buyer')
  const dest = propertiesAt(s, 'checkout.fulfillment.methods[].destinations[]')
  const attr = propertiesAt(s, 'checkout.attribution')
  return {
    op,
    phonePlacement,
    phoneCandidates,
    buyerKeys: buyer.keys,
    buyerOpaque: buyer.opaque,
    destinationKeys: dest.keys,
    destinationOpaque: dest.opaque,
    destinationAddressKeys: propertiesAt(s, 'checkout.fulfillment.methods[].destinations[].address').keys,
    supportsFulfillment: has('fulfillment.methods[]'),
    supportsLineItemIds: has('fulfillment.methods[].line_item_ids'),
    supportsGroups: has('fulfillment.methods[].groups[].selected_option_id'),
    supportsMethodId: has('fulfillment.methods[].id'),
    supportsDiscounts: has('discounts.codes') || has('discount_codes'),
    discountShape: has('discounts.codes') ? 'discounts.codes' : has('discount_codes') ? 'discount_codes' : 'none',
    attribution: {
      supported: pathStatus(s, 'checkout.attribution') === 'present',
      keys: attr.keys,
      // No listed keys → free-form string map (Checkout Kit types it that way).
      open: attr.keys.length === 0,
    },
    supportsContext: has('context'),
    supportsCartId: has('cart_id'),
    methodRequired: requiredAt(s, 'checkout.fulfillment.methods[]'),
  }
}

export interface BuildInput {
  draft: CheckoutDraft
  facts: SchemaFacts
  /** Last checkout response (update) — source of line ids / group ids. */
  last?: CommerceObject
  /** Cart for create (cart_id conversion) or local lines (buy-now). */
  cart?: CartState
  /** Include the shipping destination / option selection. */
  includeFulfillment: boolean
}

export interface BuildOutput {
  body: Json
  notes: string[]
  /** True when the body intentionally carries a non-schema key (scenario 5). */
  faultInjected: boolean
}

// Field-name synonyms, used ONLY when the canonical UCP name is absent from
// the business's live schema (seen live: `buyer_identity_contact_method_required`
// / `delivery_address_required` although email/address were sent). The name
// actually used always comes from the schema; nothing is sent blind.
const SYNONYMS: Record<string, string[]> = {
  email: ['email', 'email_address', 'contact_email'],
  first_name: ['first_name', 'given_name', 'firstName'],
  last_name: ['last_name', 'family_name', 'lastName'],
  street_address: ['street_address', 'address1', 'address_line1', 'address_line_1', 'line1'],
  address_locality: ['address_locality', 'city', 'locality'],
  address_region: ['address_region', 'province_code', 'province', 'region', 'state', 'zone_code'],
  postal_code: ['postal_code', 'zip', 'postcode'],
  address_country: ['address_country', 'country_code', 'country'],
}

const ADDRESS_FIELDS = new Set(['street_address', 'address_locality', 'address_region', 'postal_code', 'address_country'])

function resolveKey(k: string, allowed: string[]): string | undefined {
  return (SYNONYMS[k] ?? [k]).find((c) => allowed.includes(c))
}

function pick(
  obj: Record<string, string>,
  keys: readonly string[],
  allowed: string[],
  opaque: boolean,
  where: string,
  notes: string[],
  nested?: { key: string; keys: string[] },
): Json {
  const out: Json = {}
  for (const k of keys) {
    if (!obj[k]) continue
    if (opaque) {
      out[k] = obj[k]
      continue
    }
    const direct = resolveKey(k, allowed)
    if (direct) {
      out[direct] = obj[k]
      if (direct !== k) notes.push(`${where}.${k} → ${where}.${direct} (şemadaki ad)`)
      continue
    }
    // Postal address nested as { address: { … } } in some renderings.
    if (nested && ADDRESS_FIELDS.has(k)) {
      const inner = resolveKey(k, nested.keys)
      if (inner) {
        const box = ((out[nested.key] as Json | undefined) ?? (out[nested.key] = {})) as Json
        box[inner] = obj[k]
        notes.push(`${where}.${k} → ${where}.${nested.key}.${inner} (şemadaki ad)`)
        continue
      }
    }
    notes.push(`${where}.${k} şemada yok → gönderilmedi`)
  }
  return out
}

/** Build the FULL checkout body (PUT semantics). Pure; unit-tested. */
export function buildCheckoutBody({ draft, facts, last, cart, includeFulfillment }: BuildInput): BuildOutput {
  const notes: string[] = []
  const body: Json = {}
  const b = draft.buyer as unknown as Record<string, string>

  // 1. line items
  if (last) {
    body.line_items = toRequestLines(last)
  } else if (cart?.cartId && facts.supportsCartId) {
    body.cart_id = cart.cartId
    body.line_items = [] // business uses the cart's lines when cart_id is present
    notes.push('Checkout sepetten (cart_id) oluşturuldu.')
  } else {
    body.line_items = (cart?.lineItems ?? []).map((l) => ({ item: l.item, quantity: l.quantity }))
  }

  // 2. buyer
  const buyer = pick(b, BUYER_FIELDS, facts.buyerKeys, facts.buyerOpaque, 'buyer', notes)
  if (draft.includePhone && b.phone && facts.phonePlacement.startsWith('buyer.')) {
    buyer[facts.phonePlacement.split('.')[1]] = b.phone
  }
  if (Object.keys(buyer).length > 0) body.buyer = buyer

  // 3. fulfillment (destination + selected options)
  let faultInjected = false
  if (includeFulfillment && facts.supportsFulfillment) {
    const dest = pick(
      b,
      DEST_FIELDS,
      facts.destinationKeys,
      facts.destinationOpaque,
      'destination',
      notes,
      facts.destinationAddressKeys.length ? { key: 'address', keys: facts.destinationAddressKeys } : undefined,
    )
    if (draft.includePhone && b.phone && facts.phonePlacement.startsWith('fulfillment.')) {
      dest[facts.phonePlacement.split('.').pop() as string] = b.phone
    }
    if (draft.injectWrongField && dest.street_address) {
      // Scenario 5: reproduce a wrong field name on purpose.
      dest.address1 = dest.street_address
      delete dest.street_address
      faultInjected = true
      notes.push('SENARYO 5: destination.street_address → address1 olarak (kasıtlı yanlış) gönderildi.')
    }
    const lastMethod = last?.fulfillment?.methods?.find((m) => m.type === 'shipping') ?? last?.fulfillment?.methods?.[0]
    const method: Json = { type: 'shipping' }
    if (facts.supportsMethodId && lastMethod?.id) method.id = lastMethod.id
    if (facts.supportsLineItemIds) {
      const ids = lastMethod?.line_item_ids?.length
        ? lastMethod.line_item_ids
        : (last?.line_items ?? []).map((li) => li.id)
      if (ids.length > 0) method.line_item_ids = ids
    }
    method.destinations = [dest]
    if (facts.supportsGroups && lastMethod?.groups?.length) {
      const groups = lastMethod.groups
        .map((g) => ({ id: g.id, selected_option_id: draft.selectedOptions[g.id] ?? g.selected_option_id ?? undefined }))
        .filter((g) => g.selected_option_id)
      if (groups.length > 0) method.groups = groups
    }
    body.fulfillment = { methods: [method] }
  }

  // 4. discount codes (resent every time; [] clears)
  if (facts.discountShape === 'discounts.codes') body.discounts = { codes: draft.discountCodes }
  else if (facts.discountShape === 'discount_codes') body.discount_codes = draft.discountCodes
  else if (draft.discountCodes.length > 0)
    notes.push('Şema indirim kodu alanı içermiyor (discounts.codes / discount_codes) → kod gönderilemedi.')

  // 5. attribution
  if (facts.attribution.supported) {
    const all: Record<string, string> = { ...ATTRIBUTION, ...(draft.attributionExtra ?? {}) }
    const eventKey = facts.attribution.open
      ? 'event_id'
      : EVENT_ID_KEYS.find((k) => facts.attribution.keys.includes(k))
    if (eventKey) all[eventKey] = draft.draftOrderId
    const attribution: Json = {}
    for (const [k, v] of Object.entries(all)) {
      if (facts.attribution.open || facts.attribution.keys.includes(k)) attribution[k] = v
      else notes.push(`attribution.${k} şemada yok → gönderilmedi`)
    }
    body.attribution = attribution
  } else {
    notes.push('Şema attribution alanı içermiyor → atıf yalnızca continue_url UTM parametreleriyle yapılıyor.')
  }

  // 6. context hint
  if (facts.supportsContext) body.context = { address_country: draft.buyer.address_country || 'US' }

  return { body, notes, faultInjected }
}

/** continue_url + the same UTM parameters used for attribution. */
export function withUtm(continueUrl: string | undefined, draftOrderId: string): string | undefined {
  if (!continueUrl) return undefined
  try {
    const u = new URL(continueUrl)
    u.searchParams.set('utm_source', ATTRIBUTION.utm_source)
    u.searchParams.set('utm_medium', ATTRIBUTION.utm_medium)
    u.searchParams.set('utm_campaign', ATTRIBUTION.utm_campaign)
    u.searchParams.set('utm_id', draftOrderId)
    return u.toString()
  } catch {
    return continueUrl
  }
}
