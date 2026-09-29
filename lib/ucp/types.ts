// Loose, response-oriented UCP types. Request payloads are deliberately NOT
// typed here: they are always derived from the business's live `inputSchema`
// (see schema.ts) so a stale compile-time type can never hide a wrong field
// name (the `phone_number` incident in FINDINGS.md).

export type Json = Record<string, unknown>

export type MessageSeverity =
  | 'unrecoverable'
  | 'recoverable'
  | 'requires_buyer_input'
  | 'requires_buyer_review'

export interface UcpMessage {
  type: 'info' | 'warning' | 'error' | string
  code?: string
  content?: string
  content_type?: string
  severity?: MessageSeverity | string
  path?: string
  presentation?: 'notice' | 'disclosure' | string
  url?: string
  image_url?: string
}

export interface TotalLine {
  type?: string
  display_text?: string
  amount: number
}

export interface Total {
  type: string
  amount: number
  display_text?: string
  lines?: TotalLine[]
}

export interface UcpLink {
  type: string
  url: string
  title?: string
}

export interface FulfillmentOption {
  id: string
  title?: string
  description?: string
  carrier?: string
  totals?: Total[]
  earliest_fulfillment_time?: string
  latest_fulfillment_time?: string
  [k: string]: unknown
}

export interface FulfillmentGroup {
  id: string
  line_item_ids?: string[]
  options?: FulfillmentOption[]
  selected_option_id?: string | null
  [k: string]: unknown
}

export interface FulfillmentMethod {
  id?: string
  type: string
  line_item_ids?: string[]
  destinations?: Json[]
  selected_destination_id?: string | null
  groups?: FulfillmentGroup[]
  [k: string]: unknown
}

export interface LineItem {
  id: string
  item: { id: string; title?: string; price?: number; image_url?: string; [k: string]: unknown }
  quantity: number
  totals?: Total[]
  [k: string]: unknown
}

export interface UcpMeta {
  version?: string
  capabilities?: unknown
  payment_handlers?: unknown
  [k: string]: unknown
}

/** Cart or checkout as returned by the business (flattened, `ucp` alongside). */
export interface CommerceObject {
  ucp?: UcpMeta
  id: string
  status?: string
  currency?: string
  line_items?: LineItem[]
  totals?: Total[]
  messages?: UcpMessage[]
  links?: UcpLink[]
  continue_url?: string
  buyer?: Json
  fulfillment?: { methods?: FulfillmentMethod[]; [k: string]: unknown }
  discounts?: { codes?: string[]; applied?: Json[]; [k: string]: unknown }
  attribution?: Json
  order?: Json
  expires_at?: string
  [k: string]: unknown
}

/** What the server keeps about the buyer — in memory only (rule 6). */
export interface BuyerInfo {
  email: string
  first_name: string
  last_name: string
  street_address: string
  address_locality: string
  address_region: string
  postal_code: string
  address_country: string
  phone: string
}

export const DEFAULT_BUYER: BuyerInfo = {
  email: 'test@example.com',
  first_name: 'Jane',
  last_name: 'Smith',
  street_address: '123 Main Street',
  address_locality: 'Brooklyn',
  address_region: 'NY',
  postal_code: '11201',
  address_country: 'US',
  phone: '+12125550123',
}
