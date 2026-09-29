# Kauna × Shopify UCP — uygulama içi checkout prototipi (web)

Kauna'nın kullanıcıyı affiliate linkiyle markaya göndermek yerine satın almayı **Kauna'nın içinde başlatmasını** deneyen küçük bir Next.js uygulaması. Akış:

1. Shopify Catalog'da arama (veya "satıcı alan adı + ürün adı" / kimlikle lookup)
2. Ürün detayı → varyant seçimi (`get_product`) → **Sepet (Cart MCP)**
3. "Satın al" → **Checkout MCP** ile markanın mağazasında checkout oluşturma
4. Kauna'nın kendi özet ekranı: toplamlar, kargo seçenekleri, mesajlar, indirim kodu, politika linkleri
5. Markanın ödeme sayfasını (`continue_url`) açma: A) Checkout Kit, B) açılır pencere, C) ECP iframe
6. Pencere kapanınca `get_checkout` ile durum kontrolü, Kauna onay ekranı taslağı
7. Hata ayıklama paneli + "Bulguları kopyala"

Birincil test mağazası **AAB** (`https://us.aabcollection.com`). Mariam yalnızca iki satıcılı senaryoda (7) kullanılır.

> ⚠️ **Bu bir test aracıdır. Sipariş tamamlanmaz.** `complete_checkout` hiçbir kod yolunda çağrılmaz; `lib/ucp/client.ts` onu tek geçiş noktasında reddeder ve bir birim testi bunu doğrular. Her sayfada kırmızı bir uyarı bandı var. Mağazanın ödeme sayfasında **"Siparişi tamamla / Pay now"a basmayın** — basarsanız gerçek sipariş oluşur.

---

## Kurulum ve çalıştırma

Gereksinim: Node.js ≥ 22.14.

```bash
npm install
cp .env.example .env      # isteğe bağlı; boş bırakılırsa hesapsız çalışır
npm run dev               # http://localhost:3000 (0.0.0.0'a bağlanır → telefondan da açılır)
```

Diğer komutlar:

```bash
npm run build && npm start   # üretim derlemesi
npm test                     # birim testleri (vitest)
npm run typecheck
```

### Ortam değişkenleri (`.env.example`)

| Değişken | Zorunlu | Açıklama |
| --- | --- | --- |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | Hayır | Dev Dashboard → Catalog istemci bilgileri. İkisi de varsa sunucu `https://api.shopify.com/auth/access_token` (`grant_type=client_credentials`) ile token alır, bellekte ~60 dk önbelleğe alır ve her UCP isteğine `Authorization: Bearer` ekler. |
| `UCP_AGENT_PROFILE_URL` | Hayır | Her istekte `meta["ucp-agent"].profile` olarak giden agent profili. Boşsa mağazanın desteklediği sürüme göre Shopify'ın örnek profili: `https://shopify.dev/ucp/agent-profiles/<sürüm>/valid-with-capabilities.json`. |
| `UCP_TRANSPORT` | Hayır | `auto` (varsayılan: doğrudan JSON-RPC) veya `cli` (`@shopify/ucp-cli`'ı `child_process` ile çağırır). |
| `UCP_CLI_BIN` | Hayır | `cli` modunda `ucp` ikilisinin yolu. |
| `SHOPIFY_CATALOG_URL` | Hayır | Dev Dashboard'daki Catalog MCP uç noktası (ör. `https://catalog.shopify.com/api/ucp/mcp`). Olduğu gibi kullanılır; origin'in `/.well-known/ucp`'si yalnızca UCP sürümü için okunur. |
| `SHOPIFY_CATALOG_ID` | Hayır | Dev Dashboard katalog kimliği. Global aramada `saved_catalog_slug` olarak gönderilir (şemada listelenmiyor; yanlışsa `not_found` mesajı döner). |
| `UCP_CATALOG_URL` | Hayır | Global Catalog işletme URL'si (varsayılan `https://catalog.shopify.com`, `/.well-known/ucp` ile keşfedilir). |
| `DEFAULT_SELLER` | Hayır | Arayüzdeki varsayılan satıcı (varsayılan `https://us.aabcollection.com`). |
| `UCP_MAX_RETRY_AFTER_SECONDS` | Hayır | 429'da `Retry-After` bu süreden kısaysa bir kez bekleyip tekrar dener; uzunsa hatayı arayüze taşır (varsayılan 5). |

Hiçbir değişken `NEXT_PUBLIC_` değildir; sırlar tarayıcıya gitmez. `.env*` dosyaları `.gitignore`'dadır (`.env.example` hariç).

---

## Kimlik doğrulama: seçilen yol ve nedeni

Sıralama görevdeki gibi uygulandı (`lib/ucp/client.ts`):

1. **`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` varsa** → bearer token + doğrudan JSON-RPC 2.0.
2. **Yoksa → CLI'ın yöntemi, doğrudan TypeScript ile (varsayılan yol).** `@shopify/ucp-cli@0.9.0` kaynak kodu okundu (`src/core/mcp-client.ts`, `operation.ts`, `discover.ts`): CLI **istekleri imzalamıyor**. Kimliği tamamen `params.arguments.meta["ucp-agent"].profile` içindeki profil URL'sinden ibaret; mağaza bu URL'yi kendisi çekip yetenekleri müzakere ediyor. Hesapsız çalışmasının nedeni bu. Bu yüzden "taklit" edilecek bir imza yok; CLI'ın gönderdiği istekler bayt düzeyinde aynı şekilde üretiliyor: `/.well-known/ucp` → sürüm seçimi → `tools/list` (canlı şema) → `tools/call` + `meta.idempotency-key`.
3. **`UCP_TRANSPORT=cli`** → yedek adaptör (`lib/ucp/cli-adapter.ts`). `complete` için eşleme yoktur.

Neden 2 varsayılan: ek bağımlılık ve süreç başlatma maliyeti yok, istek/yanıtın tamamı hata ayıklama panelinde görünür, `tools/list` şeması doğrudan elimizde (kural 4 için gerekli). CLI yolu yalnızca doğrudan istekler bir gün farklı davranırsa karşılaştırma için duruyor.

---

## Mimari

```
app/                    Next.js App Router
  page.tsx              Arama (Global Catalog / satıcı+ürün / lookup) + hazır test ürünleri
  product/              Ürün detayı, varyant seçimi, native_checkout, Satın al
  cart/                 Satıcı başına sepet
  checkout/             Alıcı formu, özet, kargo, mesajlar, indirim, ödeme sayfası, durum
  confirmation/         Kauna onay ekranı taslağı
  settings/             Ödeme sayfası modu (A/B/C), sunucu yapılandırması
  debug/                Ham istek/yanıtlar (maskeli), checkout durumu, Bulguları kopyala
  api/…                 Tarayıcının konuştuğu TEK yer. UCP istekleri yalnızca burada yapılır.
lib/ucp/
  client.ts             Keşif, token, JSON-RPC, 429/Retry-After, şema ön kontrolü, complete yasağı
  schema.ts             Canlı inputSchema üzerinde $ref/allOf çözümleme, bilinmeyen alan tespiti, Ajv
  catalog.ts            search / lookup / get_product + products.json yedeği (önbellek yok)
  cart.ts               Cart MCP (ekleme/çıkarma yinelemeleri burada)
  checkout.ts           Tam (PUT) payload üretici, şemadan telefon yeri, atıf, UTM
  analysis.ts           Mesaj sınıflandırma, kargo metni, sessiz hata kontrolleri
  cli-adapter.ts        Yedek taşıma
lib/session.ts          Bellek içi oturum (kalıcı veritabanı yok)
lib/mask.ts             Kişisel veri maskeleme
scripts/mock-ucp-server.mjs   Çevrimdışı geliştirme için sahte UCP mağazası
tests/                  Birim testleri
```

### Uygulanan kurallar

| Kural | Nerede |
| --- | --- |
| 1. Sipariş tamamlanmaz | `FORBIDDEN_TOOLS` (`lib/ucp/client.ts`), `tests/safety.test.ts`, her sayfada uyarı bandı |
| 2. Kart verisi yok | Ödeme her zaman mağazanın sayfasında; formda kart alanı yok |
| 3. Catalog sonuçları sunucuda saklanmaz | Catalog yanıtları doğrudan tarayıcıya döner; sunucu günlüğüne yalnızca yer tutucu yazılır; görseller Shopify CDN adreslerinden `<img>` ile, `next/image` optimizasyonu kapalı |
| 4. Alan adları tahmin edilmez | Her istek `tools/list` şemasıyla karşılaştırılır; şemada olmayan alan **gönderilmez** ve hata olarak gösterilir. Telefonun yeri, indirim ve atıf şekli şemadan okunur. Yanıt tarafında sessiz hata kontrolleri (aşağıda). |
| 5. Sırlar yalnızca `.env` | Sunucu tarafı `process.env`; token yanıt gövdesi hiçbir yere yazılmaz |
| 6. Kullanıcı verisi bellekte | `lib/session.ts` — `globalThis` üzerindeki `Map`, 2 saatlik TTL, httpOnly çerez |

### Hata ayrımı

- **Protokol hataları** (`UcpError`): JSON-RPC `error` (ör. `-32000`, `-32001`), HTTP 401/403/5xx, ağ hatası, keşif hatası. İstek işlenmemiştir. **429** → `Retry-After` kısa ise bir kez beklenir, değilse arayüze "N sn sonra deneyin" olarak taşınır.
- **İş sonuçları**: başarılı `result.messages[]` içindeki `severity` değerleri → `lib/ucp/analysis.ts`:
  - `recoverable` → yalnızca eksik alan sorulur (ör. `delivery_phone_number_required` → telefon kutusu), tam payload ile `update_checkout`, sonuç yeniden değerlendirilir.
  - `requires_buyer_input` / `requires_buyer_review` / `status: requires_escalation` / `extension_interaction_required` → "Bu mağaza ödemenin kendi sayfasında tamamlanmasını istiyor" + ödeme sayfası.
  - `unrecoverable` → yeni checkout.

### `update_checkout` = PUT

`buildCheckoutBody()` her güncellemede şunları **yeniden** gönderir: istek biçimli `line_items` (satır `id` + `item.id` + `quantity`), `buyer`, teslimat adresi (`fulfillment.methods[].destinations[]`, `line_item_ids`, seçili `groups[].selected_option_id`), `discounts.codes`, `attribution`, `context`. Yanıt alanları (başlık, fiyat, görsel) geri gönderilmez.

Checkout iki adımda kurulur: `create_checkout` (sepetten `cart_id` + `line_items: []`, alıcı, indirim, atıf), ardından teslimat adresini içeren tam `update_checkout`. Bunun nedeni `line_item_ids` değerlerinin create'ten önce bilinmemesi.

### Sessiz hata kontrolleri

- Adres gönderildi ama `fulfillment.methods` boş → **"Adres işlenmemiş olabilir, alanları şemaya göre kontrol et."**
- Adres gönderildi ama yanıtta `destinations` yok → uyarı.
- `buyer.*` gönderildi ama yanıtta yok → "alan adı yanlış olabilir".
- Telefon gönderildi ama mağaza hâlâ telefon istiyor → "telefon yanlış alana yazılmış olabilir".
- Toplam kalemleri `total`'a eşit değil → uyarı (gösterim yine de mağazanın sırasıyla).

### Kargo gösterimi

Toplamlar mağazanın verdiği sırayla ve `display_text` etiketleriyle gösterilir. Kargo satırı (`fulfillment`/`shipping`) yoksa **"Kargo ödeme adımında hesaplanır"** yazılır; hiçbir zaman 0 veya "ücretsiz" gösterilmez.

### Atıf

Şema `checkout.attribution` içeriyorsa: `referring_domain=kauna.ai`, `utm_source=kauna`, `utm_medium=agentic_commerce`, `utm_campaign=in_app_checkout` ve Kauna taslak sipariş numarası (`KAUNA-YYYYMMDD-XXXXXXXX`). Etkinlik kimliği anahtarı: şema serbest bir map ise `event_id`, anahtarlar listeliyse ilk eşleşen `event_id`/`utm_id`/`click_id`/`external_id`/`utm_content`. Şemada olmayan anahtar gönderilmez ve "Teknik ayrıntılar"da not düşülür. `continue_url`'e de `utm_source`, `utm_medium`, `utm_campaign` ve `utm_id=<taslak no>` eklenir.

### Ödeme sayfası modları (Ayarlar)

- **A) Checkout Kit (web)**: `@shopify/checkout-kit@4.0.0-alpha.4` `<shopify-checkout target="popup">`. `ec.start / ec.complete / ec.close / ec.error / *.change` olayları günlüğe yazılır. Modül sayfa açılışında önceden yüklenir; böylece `open()` tıklama anında çağrılır ve açılır pencere engellenmez. 25 sn içinde hiç `ec.*` olayı gelmezse arayüz bunu raporlar ve **B moduna geçiş** butonu gösterir.
- **B) Açılır pencere / yeni sekme**: `window.open(continue_url)`. Pencere kapanınca otomatik `get_checkout`. Pencere engellenirse bağlantı gösterilir.
- **C) ECP iframe**: `continue_url` + `ec_version`, `postMessage` üzerinden JSON-RPC. `ec.ready` isteğine `{ucp:{status:"success",version}}` ile yanıt verilir, diğer istekler `-32601` alır (hiçbir yetki devredilmez). Sunucu tarafı `/api/probe-frame`, `X-Frame-Options` / `frame-ancestors` başlıklarını okuyup engel olup olmadığını raporlar. 20 sn içinde `ec.ready` gelmezse arayüz bunu raporlar.

---

## Telefonda test

**Aynı Wi-Fi:** `npm run dev` zaten `0.0.0.0:3000` dinler. Bilgisayarın yerel IP'sini bulun (`ipconfig getifaddr en0` / `hostname -I`) ve telefonda `http://192.168.x.y:3000` açın. Not: `http://` üzerinde tarayıcı panoya yazmayı engelleyebilir; bu durumda "Bulguları kopyala" metni ekranda gösterir.

**Geçici genel adres (https):**

```bash
npx cloudflared tunnel --url http://localhost:3000    # https://<rastgele>.trycloudflare.com
# veya
ngrok http 3000                                       # https://<rastgele>.ngrok-free.app
```

Bu alan adları `next.config.ts` → `allowedDevOrigins` içinde tanımlı. Checkout Kit ve açılır pencereler https altında daha tutarlı çalışır.

**Vercel:** `npx vercel` → Project Settings → Environment Variables'a `.env` değerlerini (sırlar dahil) ekleyin → `npx vercel --prod`. ⚠️ Oturumlar bellekte tutulduğu için sunucusuz ortamda istekler farklı örneklere düşerse sepet/checkout durumu kaybolabilir. Kısa demolar için sorun değil; uzun testler için tek süreçli bir sunucu (Render/Fly/Railway ya da tünel) tercih edin.

---

## Test senaryoları

Checkout ekranındaki **"Test senaryosu"** seçimi her işlemi etiketler; **Hata ayıklama → Bulguları kopyala** tabloyu gözlenen sonuçlarla doldurur.

| # | Senaryo | Satıcı | Varyant | Beklenen | Nasıl çalıştırılır |
| --- | --- | --- | --- | --- | --- |
| 1 | Telefonsuz checkout | AAB `https://us.aabcollection.com` | `gid://shopify/ProductVariant/54030028341562` (Green Tartan Maxi, 134 $) | Durum + telefon mesajı gözlemlenir. Referans (Mariam): `incomplete`, `delivery_phone_number_required` (recoverable), kargo 14,90 $ | Ana sayfa → Hazır test ürünleri → Green Tartan Maxi → "Telefonu gönder" kapalı, senaryo 1 → Checkout oluştur |
| 2 | Telefonu doğru alanla ekle | AAB | aynı | Telefon mesajı kaybolur; `requires_escalation` veya `ready_for_complete` | Senaryo 2 seç → çıkan "Eksik bilgi: Telefon" kutusuna numarayı gir → Gönder. Telefon, şemanın gösterdiği alana yazılır ("Teknik ayrıntılar"). |
| 3 | Özel bileşenli mağaza | AAB | `…/54030028341562` | `requires_escalation`, `extension_interaction_required` | Telefon açık, senaryo 3 → Checkout oluştur → "mağaza kendi sayfasını istiyor" bandı |
| 4 | AAB, başka ürün | AAB | Aramadan başka varyant (ör. Cargo Co-Ord Set Brown – XS) | Engel mağaza düzeyinde mi ürün düzeyinde mi? | Arama → "Satıcı + ürün adı" → `us.aabcollection.com` + ürün adı → ürün → Satın al (senaryo 4). 3 ile aynı mesaj gelirse engel mağaza düzeyindedir. |
| 5 | Yanlış alan adı | AAB | herhangi | Sessiz hata uyarısı görünür | "Senaryo 5: yanlış alan adı gönder" işaretle → `street_address` kasıtlı olarak `address1` diye gönderilir. Ön kontrol bunu yakalar (hata ayıklama panelinde `unknownFields`); bu senaryoda yine de gönderilir ve yanıt tarafındaki uyarı test edilir. |
| 6 | İndirim kodu | AAB | herhangi | Geçersiz kodda hangi mesaj geliyor; geçerli kodda `discounts.applied` | Özet → İndirim kodu → Uygula (senaryo 6). "Gönderilen / Mağazanın yansıttığı / Uygulandı" satırlarına bakın. |
| 7 | Farklı satıcılardan iki ürün | AAB + Mariam | — | İki ayrı checkout | Hazır ürünlerden AAB ve Mariam'ı ekle (ya da ürün sayfasından) → Sepet → her satıcı için ayrı "Satın al" |
| 8 | Ödeme sayfası modları | AAB | — | A, B (ve C) açılıyor mu, alanlar dolu mu, hangi hızlı ödeme butonları var | Ayarlar → mod → Checkout → "Ödeme sayfasını aç". Gözlemi "Mod sonucu" kutusuna yazıp Kaydet (senaryo 8). **Ödemeyi tamamlamayın.** |

Bilinen: her iki mağaza da `dev.shopify.card` ve `dev.shopify.shop_pay` ödeme handler'larını ilan ediyor; Mariam'ın uç noktası `mariamscollection.myshopify.com`, AAB'ninki `aab-usa-v2.myshopify.com`.

---

## Çevrimdışı geliştirme: sahte UCP mağazası

Gerçek mağazalara erişim yokken arayüzü denemek için `scripts/mock-ucp-server.mjs` kullanılabilir. Telefon zorunluluğunu, escalation'ı, bilinmeyen alanda adresin sessizce yok sayılmasını, `KAUNA10` indirimini ve iframe'i engelleyen `X-Frame-Options: DENY` başlığını taklit eder.

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/key.pem -out /tmp/cert.pem -days 7 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"
MOCK_TLS_CERT=/tmp/cert.pem MOCK_TLS_KEY=/tmp/key.pem node scripts/mock-ucp-server.mjs
NODE_EXTRA_CA_CERTS=/tmp/cert.pem npm run dev
# Ana sayfa → "Hazır test ürünleri" → satıcı: localhost:8443, herhangi bir varyant kimliği → Checkout’a git
```
