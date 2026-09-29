// A hand-written update_checkout inputSchema in the shape UCP businesses
// publish (allOf + local $refs). Used only by unit tests — the app always
// reads the live schema from tools/list.
export function updateCheckoutSchema(opts: { phoneOn: 'destination' | 'buyer' | 'none' } = { phoneOn: 'destination' }) {
  const postal: Record<string, unknown> = {
    type: 'object',
    properties: {
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      street_address: { type: 'string' },
      address_locality: { type: 'string' },
      address_region: { type: 'string' },
      postal_code: { type: 'string' },
      address_country: { type: 'string' },
      ...(opts.phoneOn === 'destination' ? { phone_number: { type: 'string' } } : {}),
    },
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['id', 'checkout'],
    properties: {
      meta: { type: 'object' },
      id: { type: 'string' },
      checkout: { $ref: '#/$defs/checkout' },
    },
    $defs: {
      checkout: {
        allOf: [
          {
            type: 'object',
            properties: {
              line_items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    item: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
                    quantity: { type: 'integer', minimum: 1 },
                  },
                },
              },
              buyer: {
                type: 'object',
                properties: {
                  email: { type: 'string' },
                  first_name: { type: 'string' },
                  last_name: { type: 'string' },
                  ...(opts.phoneOn === 'buyer' ? { phone_number: { type: 'string' } } : {}),
                },
              },
              context: { type: 'object', properties: { address_country: { type: 'string' } } },
            },
          },
          {
            type: 'object',
            properties: {
              fulfillment: {
                type: 'object',
                properties: { methods: { type: 'array', items: { $ref: '#/$defs/method' } } },
              },
              discounts: { type: 'object', properties: { codes: { type: 'array', items: { type: 'string' } } } },
              attribution: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
        ],
      },
      method: {
        type: 'object',
        required: ['type'],
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          line_item_ids: { type: 'array', items: { type: 'string' } },
          destinations: { type: 'array', items: postal },
          groups: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' }, selected_option_id: { type: 'string' } } },
          },
        },
      },
    },
  }
}

export const lastCheckout = {
  id: 'gid://shopify/Checkout/abc',
  status: 'incomplete',
  currency: 'USD',
  line_items: [{ id: 'li_1', item: { id: 'gid://shopify/ProductVariant/54030028341562', title: 'Green Tartan Maxi', price: 13400 }, quantity: 1 }],
  totals: [
    { type: 'subtotal', amount: 13400 },
    { type: 'fulfillment', amount: 1490, display_text: 'Shipping' },
    { type: 'tax', amount: 0 },
    { type: 'total', amount: 14890 },
  ],
  fulfillment: {
    methods: [
      {
        id: 'm_1',
        type: 'shipping',
        line_item_ids: ['li_1'],
        destinations: [{ id: 'd_1', address_country: 'US' }],
        groups: [
          {
            id: 'g_1',
            selected_option_id: 'std',
            options: [
              { id: 'std', title: 'Standard', totals: [{ type: 'total', amount: 1490 }] },
              { id: 'exp', title: 'Express', totals: [{ type: 'total', amount: 2990 }] },
            ],
          },
        ],
      },
    ],
  },
  messages: [],
  links: [{ type: 'privacy_policy', url: 'https://example.com/privacy' }],
  continue_url: 'https://us.aabcollection.com/checkouts/cn/abc',
}
