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
- "Satıcı + ürün adı" (us.aabcollection.com): satıcının UCP araması yukarıdaki `idempotency-key` nedeniyle başlangıçta engellendi (düzeltildi). Global Catalog sonuçlarında AAB bulunmadı; `/products.json` yedeği sonuç verdi.

## 9. Sonraki adımlar (kendi makinenizde)

1. `npm run dev` → Hata ayıklama → Mağaza keşfi: `us.aabcollection.com`. `checkoutSchemaFacts.phonePlacement`, `attribution`, `supportsDiscounts` ve `supportsCartId` değerlerini bu dosyaya işleyin.
2. Senaryoları 1→8 sırasıyla çalıştırın ve "Bulguları kopyala" çıktısını bu dosyaya ekleyin.
3. Mod A'da `ec.start` gelip gelmediğini ve `ec.error` içeriğini kaydedin.
