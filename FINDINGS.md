# Bulgular (FINDINGS)

Tarih: 2026-09-29. Bu dosya araştırma sırasında öğrenilenleri, dokümanla gerçek davranış arasındaki farkları ve açık soruları içerir. **Neyin doğrulandığı, neyin doğrulanamadığı açıkça ayrılmıştır.**

## 0. Önemli sınırlama: canlı mağazalara bu ortamdan erişilemedi

Prototip, ağ çıkışı kısıtlı bir bulut konteynerinde yazıldı. Kurumsal ağ politikası şu adreslere erişimi **403 ile reddetti**: `shopify.dev`, `ucp.dev`, `ucp.md`, `catalog.shopify.com`, `api.shopify.com`, `us.aabcollection.com`, `aabcollection.com`, `mariam-col.com`, `aab-usa-v2.myshopify.com`, `cdn.shopify.com`. `ucp doctor` da aynı nedenle `protocol: fail` (AGENT_PROFILE_UNREACHABLE: fetch failed) döndü.

Sonuçlar:

- Görevde listelenen shopify.dev dokümanları doğrudan **okunamadı**; yalnızca arama motoru özetleri görüldü.
- `ucp discover / --input-schema` komutları mağazalara karşı **çalıştırılamadı**. Canlı şema alanları (telefonun tam yeri, `attribution` şekli, `discounts.codes`, `cart_id`) bu yüzden **doğrulanmadı**. Uygulama bunları tahmin etmek yerine çalışma anında `tools/list` şemasından okuyor (kural 4). Kendi makinenizde ilk açılışta *Hata ayıklama → Mağaza keşfi* ile şemayı görün.
- Birincil kaynak olarak şunlar kullanıldı: **npm'den indirilen `@shopify/ucp-cli@0.9.0` kaynak kodu ve paketlenmiş skill dokümanları** (`SKILL.md`, `REFERENCE.md`, `FULFILLMENT.md`, `CATALOG.md`), **`@shopify/checkout-kit@4.0.0-alpha.4`** paket kodu ve README'si.
- Uçtan uca akış, `scripts/mock-ucp-server.mjs` ile yerel bir sahte mağazaya karşı ve Playwright ile 390×844 (iPhone) görünümde denendi: senaryo 1, 2, 5, 6, kargo seçimi, A/B/C modları, durum kontrolü ve bulgu tablosu. Sahte mağazanın davranışı görevdeki bilinen bulgulara göre yazıldı; **gerçek mağaza davranışının kanıtı değildir**.

## 1. UCP CLI nasıl kimlik doğruluyor?

`@shopify/ucp-cli` kaynağından (`src/core/mcp-client.ts`, `operation.ts`, `discover.ts`, `http-client.ts`):

- **İmzalama yok.** `SKILL.md` "the CLI additionally wraps signing and web-bot-auth at the transport layer" diyor, ancak 0.9.0 kaynağında imza, HTTP Message Signatures veya web-bot-auth kodu **bulunmuyor**. Giden istek yalnızca `User-Agent: @shopify/ucp-cli/<sürüm>`, `Content-Type`/`Accept` ve varsa kullanıcının `--header` değerlerini taşıyor. *(Doküman ile kod arasında fark.)*
- Kimlik = `params.arguments.meta["ucp-agent"].profile` içindeki **profil URL'si**. `ucp profile init` şart değil; profil seçilmediğinde CLI "Shopify-managed Profile" kullanıyor: `https://shopify.dev/ucp/agent-profiles/{2026-04-08|2026-08-25}/valid-with-capabilities.json`. Mağaza bu URL'yi her çağrıda çekiyor; çekemezse JSON-RPC `-32001` + `data.code: "profile_unreachable"` dönüyor (CLI kaynağındaki yorum: "verified live").
- Profil belgeleri imzasız: "whoever controls the advertised URL controls the agent's identity".
- CLI README: "Shopify-powered merchants support unauthenticated catalog access. **Checkout requires a Catalog JWT**." Oysa görevdeki önceki testler checkout'un hesapsız çalıştığını gösteriyor (Mariam `incomplete` / `delivery_phone_number_required`, AAB `requires_escalation`). *(Açık soru: JWT şartı yalnızca `complete_checkout` için mi, yoksa ileride mi zorunlu olacak? Token varsa uygulama onu tüm UCP isteklerine ekliyor.)*
- Token uç noktası (arama özetinden, doğrulanmadı): `POST https://api.shopify.com/auth/access_token` gövdesi `{client_id, client_secret, grant_type:"client_credentials"}` → `access_token`, istekte `Authorization: Bearer`.

**Karar:** Varsayılan yol, CLI'ın isteklerini doğrudan TypeScript ile üretmek (README'de ayrıntılı). Token ve CLI yolları da mevcut.

## 2. Protokolün tel biçimi (CLI kaynağından)

- Keşif: `GET <origin>/.well-known/ucp` → `ucp.version`, `ucp.supported_versions{sürüm: url}`, `ucp.services["dev.ucp.shopping"][] = {version, transport:"mcp", endpoint}`, `ucp.capabilities`, `ucp.payment_handlers`. İki taraf için de en yeni ortak sürüm seçiliyor (CLI: 2026-08-25, 2026-04-08). CLI yönlendirmeleri (3xx) reddediyor.
- `tools/list` params: `{arguments:{meta:{"ucp-agent":{profile}}}}`. 60 sn önbellek (UCP asgarisi).
- `tools/call` gövde sarmalayıcıları:
  - `search_catalog`, `lookup_catalog`, `get_product` → `{meta, catalog:{…}}` (get_product'ta `id`, `catalog` içinde)
  - `create_cart` → `{meta, cart}`, `update_cart` → `{meta, id, cart}`, `get_cart` → `{meta, id}`
  - `create_checkout` → `{meta, checkout}`, `update_checkout` → `{meta, id, checkout}`, `get_checkout` → `{meta, id}`
  - `complete_checkout` → `{meta, id, checkout}` (**bu prototipte hiç çağrılmıyor**)
- `meta.idempotency-key`: CLI her çağrıya UUID ekliyor (cancel/complete için zorunlu). Aynı davranış uygulandı.
- Yanıt: MCP `result.structuredContent` (öncelikli) veya `content[0].text` (JSON string). İçinde `{ucp:{…}, …nesne}`.
- Sepetten checkout'a geçiş: `checkout: {cart_id, line_items: []}`. `cart_id` verildiğinde mağaza sepetin satırlarını kullanıyor.
- Güncellemeler tam değiştirme (PUT): satırlar `{id, item:{id}, quantity}` biçiminde yeniden gönderilmeli; yeni satırlara `id` uydurulmamalı.
- Kargo: `fulfillment.methods[]` → `{type:"shipping", line_item_ids, destinations:[{first_name,last_name,street_address,address_locality,address_region,postal_code,address_country}], groups:[{id, selected_option_id}]}`. `delivery_groups` / `delivery_option_handle` kullanılmamalı (CLI uyarısı).
- Tutarlar küçük birimde (`13400` = 134,00 $). `totals[]` mağazanın sırası ve `display_text` etiketleriyle, yeniden hesaplanmadan gösterilmeli; en az bir `subtotal` ve bir `total` garanti. Kalemler toplamı tutmazsa sipariş kendiliğinden tamamlanmamalı.
- Mesaj önceliği: `unrecoverable` → `recoverable` (API ile düzelt, **devretmeden önce**) → `requires_buyer_input` → `requires_buyer_review`. `warning` + `presentation:"disclosure"` ilgili ürünün yanında, gizlenmeden gösterilmeli.
- Catalog: `eligible.native_checkout=false` "checkout mümkün değil" anlamına gelmiyor; yalnızca **API ile tamamlanamaz** demek, yani yine `continue_url`'e devredilir. `seller.domain` API adresi, `seller.url` marka kimliği. `lookup` varsayılan olarak yalnızca stoktakileri döndürür; stokta olmayanı silinmişten ayırmak için `filters.available:false` gerekir (uygulandı).

## 3. Telefon alanı (`phone_number` olayı)

Bilinen: yanlış bir alan adı gönderildiğinde mağaza hata vermeden teslimat adresini yok saydı. Checkout Kit tiplerinde (UCP `Buyer`) alıcı telefonu `phone_number` (E.164). Shopify'ın mesaj kodu `delivery_phone_number_required` ise telefonun **teslimat adresine** ait olduğunu düşündürüyor. **Canlı şema görülemediği için alanın yeri doğrulanmadı.**

Uygulamanın yaklaşımı (`lib/ucp/checkout.ts → schemaFacts`): `update_checkout` şemasında sırasıyla şu yollar aranıyor ve bulunan ilkine yazılıyor:

1. `checkout.fulfillment.methods[].destinations[].phone_number`
2. `checkout.buyer.phone_number`
3. `checkout.fulfillment.methods[].destinations[].phone`
4. `checkout.buyer.phone`

Seçilen yol ve dört adayın şemadaki durumu (`present/absent/unknown`) checkout ekranında "Teknik ayrıntılar" altında ve bulgu tablosunda görünüyor. Şemada olmayan anahtar ön kontrolde **gönderilmiyor**. Olay bu kontrolle önlenebilirdi.

## 4. Checkout Kit (mod A)

- Paket: `@shopify/checkout-kit`, yalnızca **alfa** (`next` = `4.0.0-alpha.4`, `latest` = `4.0.0-alpha.1`). README: "not production-ready". npm'den kuruldu ve derlendi. ✅
- Web bileşeni `<shopify-checkout>`. `target` = `auto` (yeni sekme) / `popup` / adlandırılmış pencere. **Satır içi (inline/iframe) sunum yok**; `_self/_parent/_top` reddediliyor. Yani web'de "uygulamanın içinde" açmak aslında popup veya sekme demek.
- `open()` çağrıldığında `continue_url`'e şunlar ekleniyor (sahte mağazada gözlendi): `ec_version=2026-04-08&ec_delegate=window.open&ec_color_scheme=web_default&ck_branding=shop&ck_version=4.0.0-alpha.4`.
- Olaylar: `ec.start`, `ec.complete`, `ec.close` (bileşene özel, sentetik), `ec.error`, `ec.fulfillment.change`, `ec.line_items.change`, `ec.totals.change`, `ec.messages.change`, `ec.buyer.change`, `ec.payment.change`. `ec.ready`'yi bileşen kendi içinde `{ucp:{status:"success",version}}` ile yanıtlıyor.
- Güvenilen mesaj kaynakları: `src` origin'i + `shop.app` (+ alt alanları); fazlası için `allowed-origins`. `continue_url` markanın alan adındaysa ve ödeme `*.myshopify.com`'a yönlenirse mesajlar reddedilebilir. Uygulama bu yüzden satıcı origin'ini ve `https://*.myshopify.com`'u ekliyor. *(Gerçek mağazada doğrulanmalı.)*
- `open()` bir kullanıcı hareketi içinde çağrılmalı; `await import()` sonrası çağrılırsa popup engelleniyor. Uygulama modülü önceden yüklüyor.
- Sahte mağazada: popup açıldı, bileşen kendi "Continue your purchase in the checkout window" örtüsünü gösterdi, ECP konuşmayan sayfadan olay gelmedi ve 25 sn sonra "B'ye geç" önerisi göründü. **Gerçek Shopify checkout'unda `ec.start` gelip gelmediği doğrulanmadı**; senaryo 8'de gözlenmeli. Checkout Kit README'si `src` olarak Storefront API `cart.checkoutUrl`'ini örnekliyor; UCP `continue_url` ile çalıştığına dair arama özeti var ("You can get a checkoutUrl from create_cart…"), ama bu doğrulanmadı.

## 5. ECP (mod C)

- Parametreler (Checkout Kit protokol kodundan): `ec_version` (zorunlu, YYYY-MM-DD), `ec_delegate` (virgülle ayrılmış: `payment.instruments_change`, `payment.credential`, `fulfillment.address_change`, `window.open`), `ec_auth`, `ec_color_scheme`.
- Taşıma: `window.postMessage` üzerinden JSON-RPC 2.0 nesneleri. İstekler (`id` içerenler) yanıt bekliyor: `ec.ready`, `ec.auth`, `ec.payment.*_request`, `ec.fulfillment.address_change_request`, `ec.window.open_request`. Bildirimler: `ec.start`, `ec.complete`, `ec.error`, `ec.*.change`.
- Uygulama hiçbir yetkiyi devretmiyor (`ec_delegate` yok) ve yalnızca `ec.ready`'yi yanıtlıyor.
- **Iframe engeli:** Shopify checkout sayfaları genellikle `X-Frame-Options`/`frame-ancestors` gönderir; web'de iframe büyük olasılıkla engellenir (Checkout Kit'in web'de yalnızca popup/sekme sunması da bunu destekliyor). Doğrulanmadı. `/api/probe-frame` gerçek mağazada başlıkları okuyup raporlar.

## 6. AAB'ye özgü notlar ve açık sorular

- Kullanıcının yapıştırdığı `aabcollection.com/products.json` örneği: Silani Oud Bakhoor (`55012944609660`, **stokta yok**), Cargo Co-Ord Set Brown (yalnızca **XS** stokta, `55760221471100`, 22.50, `compare_at_price` 45.00, etiket `30%_off`), Summer Tweed Maxi (`55396121182588` XXS/52, etiket `50%_off`, `Sale`). products.json **para birimi taşımıyor**; 22.50'nin GBP mi USD mi olduğu belli değil.
- **Açık soru:** `aabcollection.com` ile `us.aabcollection.com` aynı Shopify mağazası mı? Görevdeki bilgiye göre ABD uç noktası `aab-usa-v2.myshopify.com`. Görsellerin CDN yolu (`/s/files/1/0631/8483/0557/`) mağazaya özgü. Varyant kimlikleri mağazalar arasında geçerli değildir. Hazır ürünlerde bu örnekler `https://aabcollection.com` satıcısıyla eklendi; ABD mağazasında kullanmadan önce "Satıcı + ürün adı" aramasıyla doğrulayın. Kauna'nın ABD kullanıcıları için hedef `us.aabcollection.com` olmalı.
- **Senaryo 4:** AAB'nin `extension_interaction_required` engeli mağaza düzeyindeyse (ör. adres doğrulama veya checkout UI extension), her üründe aynı mesaj gelir. Bu durumda AAB için Kauna içinde yalnızca özet + devretme mümkün olur.
- `attribution` alanı UCP checkout şemasında `{[key]: string}` olarak tanımlı (Checkout Kit tiplerinde). Mağazanın bu alanı sipariş/analitik tarafına aktarıp aktarmadığı bilinmiyor. `continue_url` UTM'leri daha güvenilir bir yedek.
- İndirim: UCP `discounts.codes` (büyük/küçük harf duyarsız, gönderim öncekileri değiştirir, `[]` temizler) ve `discounts.applied`. AAB'nin affiliate kuponlarının UCP ile uygulanıp uygulanmadığı ve geçersiz kodda hangi `messages` kodunun geldiği senaryo 6'da gözlenmeli.
- Hız limitleri: sayısal değerler dokümana erişilemediği için bilinmiyor. Yinelemeler sepette yapılıyor; checkout'a kullanıcı başına yaklaşık 2 istek (create + tam update) ve her seçim için 1 update gidiyor.

## 7. Dokümanla gerçek davranış arasındaki farklar (bu oturumda görülen)

| Konu | Doküman / beklenti | Gözlenen |
| --- | --- | --- |
| CLI istek imzalama | SKILL.md: "wraps signing and web-bot-auth at the transport layer" | 0.9.0 kaynağında imza kodu yok; kimlik yalnızca profil URL'si |
| Checkout için JWT | CLI README: "Checkout requires a Catalog JWT" | Görevdeki önceki testler hesapsız checkout oluşturabildi |
| Checkout Kit "uygulama içinde" | Genel tanım: "embeds the purchase flow directly in your application" | Web bileşeni yalnızca popup / yeni sekme (+ örtü) sunuyor, inline yok |
| Checkout Kit sürümü | — | Yalnızca alfa; `latest` etiketi bile alfa (4.0.0-alpha.1) |
| `meta.idempotency-key` | ucp-cli her çağrıya ekliyor ("accepting one is harmless") | **Canlı (Mac'ten, 2026-09-29):** `us.aabcollection.com` `search_catalog` şeması `meta`'yı yalnızca `ucp-agent` içeren kapalı bir nesne olarak tanımlıyor; anahtar şemada yok. Ön kontrol yakaladı ve istek gönderilmedi. Artık anahtar yalnızca şema kabul ediyorsa (veya `meta` hiç tanımlı değilse) ekleniyor. |

## 8. Canlı gözlemler (kullanıcının makinesinden)

- Token (client credentials) + `SHOPIFY_CATALOG_URL` ile Global Catalog araması yanıt verdi.
- **Token kapsamı:** Catalog token'ı (`Authorization: Bearer`) mağazanın uç noktasına da gönderildiğinde `aab-usa-v2.myshopify.com` her çağrıda JSON-RPC `-32000 AuthenticationFailed` döndü (arama ve Satın al → sepet). *(2026-10-02 itibarıyla geçersiz; bkz. §13.)* O zaman token yalnızca Catalog'a gönderilecek şekilde değiştirilmişti. Shopify'ın resmi akışına göre checkout araçları token **ister**, sepet araçları istemez. Prototip artık buna uyuyor; ret olursa açıkça raporluyor.
- Global Catalog, AAB ürününü (`Green Tartan Maxi`, 134 $ USD, `…/54030028341562`, seçenekler: Dress length 52/54 in, Size XXS …) satıcı `aab-usa-v2.myshopify.com` ile ve `eligible.native_checkout: false` olarak döndürdü → escalation beklentisiyle uyumlu.
- **Hız limiti (429):** Ürün sayfasındaki otomatik kargo tahmini her görüntülemede geçici bir checkout (create + update) açınca kısa sürede `HTTP 429`, `Retry-After: 3588` (≈ 1 saat) alındı. Checkout MCP limitleri gerçekten sıkı ve pencere saat mertebesinde. Önlemler: otomatik tahmin yalnızca Cart MCP ile; checkout ile tahmin yalnızca açık tıklamayla; tahminler sekme belleğinde tutuluyor; 429 sonrası süre bitene kadar o uç noktaya hiç istek gönderilmiyor (devre kesici); Satın al 429'da Catalog `checkout_url`'ine düşüyor (form dolu değil).
- "Satıcı + ürün adı" (us.aabcollection.com): satıcının UCP araması yukarıdaki `idempotency-key` nedeniyle başlangıçta engellendi (düzeltildi). Global Catalog sonuçlarında AAB bulunmadı; `/products.json` yedeği sonuç verdi.

## 9. Kapsamlı inceleme (2026-09-29) — bulunan ve düzeltilen hatalar

Kaynak yeniden tarandı (`@shopify/ucp-cli` 0.9.0 `cli/cta.ts`, `core/escalation.ts`; `@shopify/checkout-kit` 4.0.0-alpha.4) ve kod baştan sona gözden geçirildi.

| # | Sorun | Etki | Düzeltme |
| --- | --- | --- | --- |
| 1 | İndirim kodu yalnızca `discounts.codes` biçiminde aranıyordu; ucp-cli ipucu `discount_codes[]` biçimini de anıyor | Şema diğer biçimi kullanırsa kod hiç gönderilmezdi | Biçim şemadan okunuyor (`discountShape`) |
| 2 | MCP `isError: true` yanıtları başarılı sayılıyordu | Araç hatası boş checkout gibi görünürdü | UCP nesnesi taşımayan `isError` → protokol hatası |
| 3 | Paralel Catalog çağrıları token'ı birden çok kez istiyordu | Gereksiz token istekleri | Tek bekleyen istek paylaşılıyor |
| 4 | "Satın al" her tıklamada sepete aynı ürünü **yeniden ekliyordu** (adet 1→2→3) | Yanlış adet + her seferinde yeni checkout | `ensure` işlemi; adet artmaz |
| 5 | "Satın al" her tıklamada yeni checkout açıyordu (create + update) | Checkout MCP limiti hızla doluyordu | Satırlar aynıysa mevcut checkout tek `update` ile yeniden kullanılıyor |
| 6 | Süresi dolmuş `cart_id` ile checkout oluşturma başarısızdı | Satın al kırılırdı | Bir kez `line_items` ile yeniden deneniyor |
| 7 | Sepet güncellemesi reddedilince artırılan adet geri alınmıyordu | Yerel sepet ile mağaza ayrışırdı | Tam anlık görüntüyle geri alma |
| 8 | `setQuantity` geçersiz sıra numarasında `splice(-1)` ile **son ürünü siliyordu** | Yanlış ürün silinirdi | Sıra numarası denetimi |
| 9 | Ürün sayfasında satıcı bulunamazsa sepet Catalog adresine yönleniyordu | Satın al yanlış uç noktaya giderdi | Satıcı: varyant → ürün düzeyi → PDP host; Catalog'a asla düşmez |
| 10 | Arama sonrası üründen geri dönünce sonuçlar kayboluyordu | Kullanılabilirlik | Sorgu URL'de; geri gelince yeniden çalışır (sunucuda saklanmaz) |
| 11 | "Temizle" kod kutusunu boşaltmıyordu; negatif indirim "−−" gösteriyordu; yenilemede kod kayboluyordu | Arayüz | Düzeltildi |
| 12 | `incomplete` durumu kırmızı (hata gibi) gösteriliyordu | Yanlış yönlendirme | Sarı (eylem gerekli) |

Uçtan uca test (sahte mağaza, Playwright; mobil 390×844 açık tema + masaüstü 1280 koyu tema): arama, satıcı gösterimi, geri dönüş, varyant seçimi, tıklamasız kargo tahmini, Satın al → ödeme sayfası (UTM'li), checkout yeniden kullanımı, adet koruması, geçersiz/geçerli indirim, kargo seçeneği, senaryo 1/2, durum kontrolü, sepet sayacı, PII maskesi, bulgu tablosu, mod A hazırlığı, yatay taşma ve sayfa hataları → **56/56 geçti**. Birim testleri 31/31.

## 10. Kimlik katmanları ve hız limitleri (Kauna canlıya geçerken)

Kaynaklar: [Auth and rate limiting](https://shopify.dev/docs/agents/profiles/auth-and-rate-limiting), [Authenticate your agent](https://shopify.dev/docs/agents/get-started/authentication), [Checkout MCP](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp), [Cart MCP](https://shopify.dev/docs/agents/carts-and-checkout/cart-mcp), [UCP overview](http://ucp.dev/2026-04-08/specification/overview/), Shopify Developer Community: [Checkout MCP authentication issue](https://community.shopify.dev/t/checkout-mcp-authentication-issue/37604), [Missing required buyer IP header](https://community.shopify.dev/t/checkout-mcp-create-checkout-fails-with-missing-required-buyer-ip-header-despite-following-official-demo/33939). Sayfalar bu ortamdan açılamadı; içerik arama özetlerinden alındı ve **birebir doğrulanmadı**.

**Shopify ajan trafiğini üç katmana ayırıyor; limitler katmana göre değişiyor:**

| Katman | Nasıl | Erişim | Limit |
| --- | --- | --- | --- |
| Token | `Authorization: Bearer <JWT>` (Dev Dashboard client credentials, 60 dk) | Catalog, sepet, checkout, sipariş; `complete_checkout` yalnızca izin verilmiş token'la; `get_order` için `read_global_api_orders` kapsamı | En yüksek |
| İmzalı | RFC 9421 HTTP Message Signatures (ECDSA P-256); açık anahtar ajanın `/.well-known/ucp` profilinde | Sepet ve checkout | Orta |
| Anonim | Yalnızca `meta["ucp-agent"].profile` | Catalog, sepet, checkout oluşturma/düzenleme; `complete_checkout` ve sipariş araçları yok | En düşük |

- Her katmanda **Checkout MCP, Cart MCP'den daha sıkı** sınırlanıyor. Öneri: yinelemeler sepette, checkout yalnızca satın almaya hazır alıcı için.
- Sayısal limitler (dakika/saat başına istek) dokümanda **yayınlanmamış**. Gözlenen: anonim checkout'ta kısa bir denemeden sonra `HTTP 429`, `Retry-After: 3588` (≈ 1 saat).
- 429'da `Retry-After` başlığına (REST) veya `error.data.retry_after` alanına (MCP) uyulmalı. İkisi de artık uygulanıyor, süre dolana kadar o uç noktaya istek gönderilmiyor.

**Bu prototipteki durum (canlı gözlem):**
- Dev Dashboard token'ı (kapsamlar: `read_global_api_catalog_search`, `write_global_api_app_events`) **Global Catalog'da çalışıyor**.
- Aynı token mağazanın Checkout/Cart MCP'sine gönderilince `-32000 AuthenticationFailed` dönüyor. Forumda aynı sorunu yaşayan başka geliştiriciler var; token olmadan istek çalışıyor. Yani bugün sepet ve checkout **anonim katmanda** çalışıyor.
- İmzalı katman uygulanmadı; ucp-cli 0.9.0 da imzalamıyor.

**Kauna canlıya geçtiğinde ne değişir (öneri ve açık sorular):**
1. **Anonim katman canlı için yetersiz.** Tüm Kauna kullanıcılarının istekleri aynı sunucudan çıkacağından anonim kotayı büyük olasılıkla birlikte tüketirler. Tek kullanıcılı testte bile ≈1 saatlik 429 alındı. Limitin IP'ye mi, ajan profiline mi yoksa ikisine birden mi bağlı olduğu yayınlanmamış.
2. **Kauna adına ayrı kimlik:** Dev Dashboard'da Kauna organizasyonu altında uygulama/katalog anahtarı, Kauna alan adında barındırılan ajan profili (ör. `https://kauna.ai/.well-known/ucp`). Kişisel dev hesabı yerine bu kullanılmalı. `UCP_AGENT_PROFILE_URL` bunu destekliyor.
3. **Checkout için Token katmanına erişim** şu an dev token'ıyla çalışmıyor. Shopify'dan (partner/agentic commerce ekibi) Kauna token'ının checkout/cart için yetkilendirilmesi istenmeli. Alternatif olarak **İmzalı katman**: bir anahtar çifti, Kauna profilinde açık anahtar, her isteğin RFC 9421 ile imzalanması. Forumda imzalı isteklerde `key_not_found` sorunu bildirilmiş; olgunluğu belirsiz.
4. Token katmanında checkout için alıcı IP'si istenebiliyor (forumda "Missing required buyer IP header"). Kauna sunucusu alıcının IP'sini `signals` (ör. `dev.ucp.buyer_ip`) ile iletmeli. Tam alan adı canlı şemadan doğrulanmalı.
5. Sayısal limitler ve katman yükseltme süreci Shopify'a sorulmalı: dakika/saat başına istek, mağaza başına mı toplam mı, 429 pencere süresi.

**Uygulamada görünürlük:** §13'e bakın. Kimlik yolu artık `token` / `token yok – tasarım gereği` / `token yok – yedek` (yalnızca test) / `CLI (test)` olarak etiketleniyor. Token alınamazsa istek gönderilmiyor; anonim yedek yalnızca test ayarıyla açılıyor.

## 11. Alıcı/adres işlenmemesi (`buyer_identity_contact_method_required`, `delivery_address_required`)

Canlı bir checkout'ta e-posta ve adres işlenmedi. Kök nedeni canlı şema görülmeden kesinleştirilemedi. Olası iki neden var: mağaza şemasının farklı alan adları kullanması (örn. `email_address`, `address1`, iç içe `address`) ya da adresin yalnızca ikinci istekte (update) gönderilmesi ve o isteğin başarısız olması.

Düzeltme:
1. Alan adları şemadan çözümleniyor. Kanonik ad yoksa şemadaki eş anlamlı kullanılıyor, iç içe `address` destekleniyor ve her eşleme raporlanıyor.
2. Mobil uç noktada adres, şema izin veriyorsa `create_checkout` içinde gönderiliyor.

Bu mesajlar gelirse hem web özetinde (sessiz hata kontrolleri) hem de mobil özette açık uyarı gösteriliyor.

## 12. Sonraki adımlar (kendi makinenizde)

0. **Önce kimlik akışı:** `node --env-file=.env scripts/verify-auth-flow.mjs` çalıştırın, üretilen `verify-auth-report.md` tablosunu §13.3'e yapıştırın (bkz. §13).

1. `npm run dev` → Hata ayıklama → Mağaza keşfi: `us.aabcollection.com`. `checkoutSchemaFacts.phonePlacement`, `attribution`, `supportsDiscounts` ve `supportsCartId` değerlerini bu dosyaya işleyin.
2. Senaryoları 1→8 sırasıyla çalıştırın ve "Bulguları kopyala" çıktısını bu dosyaya ekleyin.
3. Mod A'da `ec.start` gelip gelmediğini ve `ec.error` içeriğini kaydedin.

## 13. Resmi kimlik doğrulama akışına geçiş (2026-10-02)

Kaynak: Shopify "Authenticate your agent" (6 adım + her sayfanın "Next steps" kısmı). Sayfalar bu ortamdan açılamadı; uygulanan desen kullanıcının özetinden alındı.

### 13.1 Ne değişti

| Konu | Önce | Şimdi |
| --- | --- | --- |
| Checkout araçları | token **gönderilmiyordu** (canlıda `AuthenticationFailed` görüldüğü için) | `Bearer` token gönderiliyor (`create/get/update/cancel_checkout`) |
| Sepet araçları, mağaza kataloğu | anonim | token yok — *tasarım gereği* (etiketli) |
| Token alınamazsa | Global Catalog sessizce anonim devam ediyordu | İstek **gönderilmiyor**. Kalıcı band "Token alınamadı: <neden>", panelde ve günlükte hata |
| Mağaza token'ı reddederse | — | `AuthenticationFailed` arayüzde ve panelde açıkça. Token'sız tekrar **yok**. Yalnızca Ayarlar → "Token reddedilirse token'sız dene (yalnızca test)" ile bir kez tekrar, `token yok – yedek ⚠` etiketiyle |
| CLI adaptörü | `UCP_TRANSPORT=cli` | Yalnızca test ayarı (Ayarlar veya aynı env) |
| Token yenileme | 5 dk erken | `exp`'ten 1 dk önce. JWT `scopes` / `exp` / `limits` okunup panelde gösteriliyor |
| Kimlik bilgisi adları | `SHOPIFY_CLIENT_ID/SECRET` | aynı + eski adlar uyarıyla okunuyor |
| Profil | her çağrıda `/{sürüm}/valid-with-capabilities.json` | katalog: `examples/2026-08-25/valid-with-capabilities.json`; sepet/checkout: `examples/2026-08-25/cart-and-checkout.json` (veya cart+checkout ilan eden `UCP_AGENT_PROFILE_URL`) |
| Başlık | — | her JSON-RPC isteğinde `MCP-Protocol-Version: 2026-03-26` |
| `cart_id` | `checkout.cart_id` + `line_items: []` | şema üst düzeyde listeliyorsa **üst düzey** `cart_id` + sepet satırları; `checkout` içinde listeliyorsa orada; hiç yoksa satırlarla (not düşülür) |
| `update_checkout` | son yanıttan tam gövde | önce `get_checkout`, sonra tam PUT (`currency`, `context`, `line_items` `{quantity, item:{id}}`, `buyer` …) |
| Katalog kimliği | `catalog.saved_catalog_slug` | `catalog.catalog_id` |
| Mağaza uç noktası | yalnızca `/.well-known/ucp` | `/.well-known/ucp`, okunamazsa `{mağaza}/api/ucp/mcp` |
| İptal | yok | `cancel_checkout` (Checkout sayfasında "Checkout'u iptal et"). `complete_checkout` hâlâ yasak |
| Teşhis | rozet | istek başına araç, uç nokta, kimlik yolu etiketi, profil, token kapsamları + bitiş, yanıt kaynağı (`structuredContent` / `content[0].text`), maskeli ham yanıt; "Bulguları kopyala" çıktısına kimlik tablosu eklendi |

`/api/mobile/ucp-checkout` aynı istemciyi kullandığı için aynı kurallara uyuyor (checkout token'lı; adres güncellemesinden önce `get_checkout`). Mobil test günlüğünde kimlik yolu etiketleri gösteriliyor; yedek çağrılar ⚠ ile işaretli.

### 13.2 Bu ortamda doğrulananlar (sahte sunucu)

Sahte sunucu artık kuralı katı uyguluyor: checkout token'sız → hata, sepete token gelirse → hata, Global Catalog örneği token ister, `MCP-Protocol-Version` zorunlu.

- `scripts/verify-auth-flow.mjs` sahte sunucuya karşı: 7/7 adım ✓ (token → katalog → keşif → `create_cart` token'sız → `create_checkout` token'lı, üst düzey `cart_id` → `get_checkout` + `update_checkout` `buyer.email` → `cancel_checkout`).
- `MOCK_REJECT_TOKEN=1` ile: adım 5 `AuthenticationFailed` olarak raporlandı, token'sız tekrar yok, sonraki adımlar atlandı.
- Web: 55 birim testi (11'i yeni kimlik testi), uçtan uca 56/56 (mobil + masaüstü koyu). Sahte sunucu günlüğü: `create_cart auth=none` ×7, `create/get/update/cancel_checkout auth=bearer`. Kural dışı tek istek yok.
- Token hatası senaryosu (tarayıcıda): arama durdu, kalıcı band "Token alınamadı: HTTP 404 — not found", durum satırı `Global Catalog: token ✗ · Mağaza katalog: token yok (tasarım gereği) · Sepet: token yok (tasarım gereği) · Checkout: token ✗`. Test ayarı açılınca çağrı `token yok – yedek` olarak işaretlendi.
- Mobil: TypeScript temiz, `expo export` Android + iOS ✓; `/api/mobile/ucp-checkout` → `create_checkout: token`.

### 13.3 Canlı doğrulama (sizin Mac'inizde)

```bash
node --env-file=.env scripts/verify-auth-flow.mjs
```

Çıktıdaki tabloyu buraya yapıştırın. Özellikle 5. adım önemli: AAB (`aab-usa-v2.myshopify.com`) Dev Dashboard token'ını checkout'ta kabul ediyor mu? 2026-09-29'da reddetmişti (§8).

- **Reddederse:** token'ın kapsamı (1. adımdaki `scopes`) checkout için yetersiz olabilir. Dev Dashboard'da checkout kapsamı ya da Shopify'dan erişim gerekebilir. Bu, "Next steps" sayfalarındaki onay sürecine bağlı. Uygulama bu durumda checkout'u durdurur ve hatayı gösterir.
- **Sadece test için:** Ayarlar'daki yedek açılarak eski davranış (token'sız) denenebilir.

_(sonuçlar bekleniyor)_

