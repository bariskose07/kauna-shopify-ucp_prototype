import { describe, expect, it } from 'vitest'

import { maskSecret, parseCheckoutId, toVariantGid } from '../lib/mobile-checkout'
import { appendParam, hostPath, mask6, maskUrl, toGidVariant, toNumericVariant } from '../mobile-harness/src/ids'

describe('mobile checkout helpers (server)', () => {
  it('splits gid://shopify/Checkout/{TOKEN}?key={KEY}', () => {
    expect(parseCheckoutId('gid://shopify/Checkout/hWN123abc?key=0123456789abcdef0123456789abcdef')).toEqual({
      cartToken: 'hWN123abc',
      cartKey: '0123456789abcdef0123456789abcdef',
    })
    expect(parseCheckoutId('gid://shopify/Checkout/hWN123abc')).toEqual({ cartToken: 'hWN123abc', cartKey: undefined })
    expect(parseCheckoutId('something-else')).toEqual({})
  })
  it('normalises variant ids and masks secrets', () => {
    expect(toVariantGid('47830495691066')).toBe('gid://shopify/ProductVariant/47830495691066')
    expect(maskSecret('0123456789abcdef')).toBe('012345…')
  })
})

describe('mobile harness ids', () => {
  it('converts numeric ↔ gid', () => {
    expect(toNumericVariant('gid://shopify/ProductVariant/47830495854906')).toBe('47830495854906')
    expect(toGidVariant('47830495854906')).toBe('gid://shopify/ProductVariant/47830495854906')
  })
  it('masks cart tokens, keys and prefill values in URLs (rule 5/7)', () => {
    const u =
      'https://us.aabcollection.com/cart/c/hWN0123456789?key=abcdef0123456789&checkout%5Bemail%5D=test%40example.com&checkout%5Bshipping_address%5D%5Bzip%5D=11201'
    const m = maskUrl(u)
    expect(m).not.toContain('hWN0123456789')
    expect(m).not.toContain('abcdef0123456789')
    expect(m).not.toContain('test%40example.com')
    expect(m).not.toContain('11201')
    expect(m).toContain('/cart/c/hWN012…')
    expect(mask6(undefined)).toBe('—')
  })
  it('appends sca_ref with & when the URL already has a query', () => {
    expect(appendParam('https://s/checkouts/cn/x?key=y', 'sca_ref', '11820123.M7RFlqVRLGp')).toBe(
      'https://s/checkouts/cn/x?key=y&sca_ref=11820123.M7RFlqVRLGp',
    )
  })
  it('parses host/path without the URL polyfill', () => {
    expect(hostPath('https://us.aabcollection.com/checkouts/cn/x?key=1')).toEqual({ host: 'us.aabcollection.com', path: '/checkouts/cn/x' })
  })
})
