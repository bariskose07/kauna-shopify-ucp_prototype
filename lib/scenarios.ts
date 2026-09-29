// Test scenarios + quick-pick presets. Client-safe (no server imports).
// Primary seller is AAB (us.aabcollection.com) per product decision; Mariam is
// kept only where a second seller is needed (scenario 7) and as a reference
// for the known phone behaviour.

export const AAB_US = 'https://us.aabcollection.com'
export const AAB_MAIN = 'https://aabcollection.com'
export const MARIAM = 'https://mariam-col.com'

export interface Scenario {
  id: string
  title: string
  seller: string
  variant: string
  expected: string
  howTo: string
}

export const SCENARIOS: Scenario[] = [
  {
    id: '1',
    title: 'Telefonsuz checkout',
    seller: 'AAB (`https://us.aabcollection.com`)',
    variant: '`gid://shopify/ProductVariant/54030028341562` (Green Tartan Maxi, 134 $)',
    expected:
      'Durum + telefon mesajı gözlemlenir. Referans (Mariam): `incomplete`, `delivery_phone_number_required` (recoverable), kargo 14,90 $',
    howTo: 'Ana sayfa → hazır ürün "Green Tartan Maxi" → Checkout; "Telefonu gönder" kapalı, senaryo = 1.',
  },
  {
    id: '2',
    title: 'Telefonu doğru alanla ekle',
    seller: 'AAB',
    variant: 'aynı',
    expected: 'Telefon mesajı kaybolur; durum `requires_escalation` veya `ready_for_complete`',
    howTo: 'Senaryo 1 sonrası çıkan "Eksik bilgi: telefon" kutusuna numarayı girip gönder (senaryo = 2).',
  },
  {
    id: '3',
    title: 'Özel bileşenli mağaza',
    seller: 'AAB',
    variant: '`gid://shopify/ProductVariant/54030028341562` (Green Tartan Maxi, 134 $)',
    expected: '`requires_escalation`, `extension_interaction_required`',
    howTo: 'Telefon açık, senaryo = 3 → Checkout oluştur. Uyarı bandı "mağaza kendi sayfasını istiyor" göstermeli.',
  },
  {
    id: '4',
    title: 'AAB, başka ürün',
    seller: 'AAB',
    variant: 'aramadan başka bir varyant (ör. Cargo Co-Ord Set Brown – XS)',
    expected: 'Engel mağaza düzeyinde mi ürün düzeyinde mi?',
    howTo: 'Arama → "Satıcı + ürün adı" (us.aabcollection.com + "abaya") → farklı ürün → Checkout (senaryo = 4).',
  },
  {
    id: '5',
    title: 'Yanlış alan adı',
    seller: 'AAB',
    variant: 'herhangi',
    expected: 'Sessiz hata uyarısı görünür',
    howTo: 'Checkout formunda "Senaryo 5: yanlış alan adı gönder" işaretle. street_address → address1 gönderilir.',
  },
  {
    id: '6',
    title: 'İndirim kodu',
    seller: 'AAB',
    variant: 'herhangi',
    expected: 'Geçersiz kodda hangi mesaj geliyor; geçerli kod varsa `discounts.applied`',
    howTo: 'Özet ekranında "İndirim kodu" alanına ör. KAUNA10 yaz → Uygula (senaryo = 6).',
  },
  {
    id: '7',
    title: 'Farklı satıcılardan iki ürün',
    seller: 'AAB + Mariam',
    variant: '—',
    expected: 'İki ayrı checkout oluşur',
    howTo: 'Sepete bir AAB ve bir Mariam ürünü ekle → Sepet sayfasında her satıcı için ayrı "Satın al".',
  },
  {
    id: '8',
    title: 'Ödeme sayfası modları',
    seller: 'AAB',
    variant: '—',
    expected: 'A, B (ve varsa C) modlarında sayfa açılıyor mu, alanlar dolu mu, hangi hızlı ödeme butonları var',
    howTo: 'Ayarlar → mod seç → Özet ekranında "Ödeme sayfasını aç". Sonucu "Mod sonucu" kutusuna yaz.',
  },
]

export interface Preset {
  label: string
  seller: string
  variantId: string
  note?: string
}

export const PRESETS: Preset[] = [
  {
    label: 'Green Tartan Maxi (134 $)',
    seller: AAB_US,
    variantId: 'gid://shopify/ProductVariant/54030028341562',
    note: 'Senaryo 1/2/3',
  },
  {
    label: 'Cargo Co-Ord Set Brown – XS',
    seller: AAB_MAIN,
    variantId: 'gid://shopify/ProductVariant/55760221471100',
    note: 'aabcollection.com/products.json örneği (stokta)',
  },
  {
    label: 'Summer Tweed Maxi – XXS / 52',
    seller: AAB_MAIN,
    variantId: 'gid://shopify/ProductVariant/55396121182588',
    note: 'aabcollection.com/products.json örneği',
  },
  {
    label: 'Silani Oud Bakhoor (stok yok)',
    seller: AAB_MAIN,
    variantId: 'gid://shopify/ProductVariant/55012944609660',
    note: 'Stok dışı davranışı için',
  },
  {
    label: 'Elegant Solid Color Abaya (28,90 $)',
    seller: MARIAM,
    variantId: 'gid://shopify/ProductVariant/43821444464856',
    note: 'Yalnızca senaryo 7 (ikinci satıcı)',
  },
]
