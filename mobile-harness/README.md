# Kauna mobil test uygulaması (Expo) — dört ödeme modu

Aynı ürünü telefonda dört farklı yöntemle mağazanın ödeme sayfasına kadar götürüp karşılaştırmak için. Mod ve açılış seçeneği uygulamanın **Ayarlar** sekmesinden seçilir.

> ⚠️ **TEST.** Ödeme hiçbir zaman tamamlanmaz; her ekranda kırmızı uyarı bandı var. Mağaza sayfasında “Pay now / Siparişi tamamla”ya basmayın — basarsanız gerçek sipariş verilir.
> Uygulama `_up_click_id`'yi **hiçbir zaman** üretmez, kopyalamaz veya yazmaz. Yalnızca okur (var mı, ilk 6 karakter). Kimliği yalnızca UpPromote'un kendi kodu, ref'li sayfa telefonda açıldığında yazar. UpPromote'un iç uç noktaları çağrılmaz.

## Kurulum

Gerekenler: bilgisayarda Node.js ≥ 22, telefonda **Expo Go** (App Store / Google Play). Telefon ve bilgisayar aynı Wi-Fi'da olmalı.

### 1. Sunucu (web prototipi, bir üst klasör)

Mobil uygulama UCP'ye doğrudan bağlanmaz; Shopify kimlik bilgileri yalnızca sunucunun `.env` dosyasındadır.

```bash
cd ..                 # repo kökü
npm install
npm run dev           # 0.0.0.0:3000 dinler → telefondan erişilebilir
```

Bilgisayarın yerel IP'si:
- Mac: `ipconfig getifaddr en0`
- Windows: `ipconfig` → “IPv4 Address”
- Linux: `hostname -I`

Telefonda tarayıcıdan `http://<IP>:3000` açılıyorsa sunucu hazırdır. Uygulamanın **Ayarlar → Sunucu adresi** alanına `http://<IP>:3000` yazın.

Farklı ağlardaysanız tünel kullanın ve tünel adresini Sunucu adresi alanına yazın:

```bash
npx cloudflared tunnel --url http://localhost:3000   # → https://<rastgele>.trycloudflare.com
# veya
ngrok http 3000
```

### 2. Mobil uygulama

```bash
cd mobile-harness
npm install
npx expo start            # QR kodu çıkar
npx expo start --tunnel   # telefon başka ağdaysa
```

iPhone'da Kamera ile, Android'de Expo Go içinden QR'ı okutun.

## Yeni sunucu uç noktası

`POST /api/mobile/ucp-checkout` (mevcut uç noktalara dokunulmadı):

```json
{ "seller": "https://us.aabcollection.com", "variantId": "gid://shopify/ProductVariant/47830495691066",
  "quantity": 1, "buyer": { … }, "attemptId": "KAUNA-ATT-…" }
```

Yanıt: `status`, `totals`, `shipping`, `messages`, `buyerWarnings`, `continueUrl`, `cartToken`, `cartKey`, `auth` (adım başına kimlik yolu: `token` / `token yok – tasarım gereği` / `token yok – yedek` ⚠ (yalnızca test) / `CLI (test)`), `fieldNotes`, `timings`.

Kimlik kuralı web prototipiyle aynıdır: checkout araçları Shopify token'ı ile çağrılır. Token alınamazsa ya da mağaza reddederse (`AuthenticationFailed`) istek token'sız tekrarlanmaz; hata özet ekranında görünür. Token yalnızca sunucuda kalır.

- **Durumsuzdur.** `cartToken`/`cartKey` yalnızca bu yanıtta döner; sunucu bunları saklamaz, loglarda yalnızca ilk 6 karakter görünür.
- `attribution.utm_content` = telefondaki deneme numarası. Günlükteki kayıtla mağaza tarafı eşleştirilebilir.
- Teslimat adresi, şema izin veriyorsa `create_checkout` içinde gönderilir (tek istek). Mağaza hâlâ adres/iletişim eksik diyorsa bir kez tam `update_checkout` yapılır.

**Alıcı bilgisi hatasının düzeltilmesi** (`buyer_identity_contact_method_required`, `delivery_address_required`):
- Alanların adları artık her zaman mağazanın canlı şemasından okunuyor. Kanonik UCP adı (`email`, `street_address`, `postal_code` …) şemada yoksa şemanın kendi adı kullanılıyor (`email_address`, `address1`, `zip`, `province_code` …).
- Adres iç içe bir `address` nesnesindeyse alanlar oraya yerleştiriliyor.
- Telefonun alanı da şemadan bulunuyor.
- Her eşleme `fieldNotes` içinde raporlanıyor ve uygulamada gösteriliyor. Bu mesajlar yanıtta varsa özet ekranında kırmızı bir uyarı çıkıyor.
- Ortak kodda (`lib/ucp/checkout.ts`) yapılan değişiklik yalnızca kanonik adın şemada **olmadığı** durumda devreye girer. Web prototipinin bugün çalışan davranışı aynıdır.

## Modlar

| Mod | Ne yapar | Affiliate |
| --- | --- | --- |
| **A – Sadece UCP** | UCP checkout → özet → `continue_url` | Yok (karşılaştırma için) |
| **B – Mağaza sepeti** | (UCP özeti bilgi için) → görünmez WebView ref'li ürün sayfası → `/cart.js`'te `_up_click_id` bekle (8 sn) → `/cart/add.js` → `token` → `{mağaza}/cart/c/{token}&checkout[...]` (veya ayara göre aynı WebView'da `/checkout?checkout[...]`) | Sepette `_up_click_id` |
| **C – UCP + çerez** (varsayılan) | UCP checkout **ile aynı anda** görünmez WebView mağazanın `/cart.js` adresini açar (küçük JSON; ana sayfa artık açılmıyor; yalnızca `/cart.js` açılamazsa yedek olarak açılıyor) → önceki `cart` çerezini sakla → çerezi UCP sepetine ayarla → `/cart.js` ile doğrula → ref'li ürün sayfası (tek tam sayfa) → `_up_click_id` + token eşleşmesini bekle → **önceki sepeti geri koy** (yoksa çerezi sil) → `continue_url` (+ ayara göre `&sca_ref`). UCP sonrası her şey **süre sınırına** tabi (varsayılan 6 sn). Aşılırsa yükleme durdurulur, sepet geri konur, yedek moda geçilir. | UCP sepetinde `_up_click_id`; yazılmazsa ya da süre aşılırsa ayara göre D / B / dur |
| **D – UCP + sca_ref** | UCP checkout → `continue_url&sca_ref=…` | Belirsiz (piksele bağlı) |

Mod C'de geri yükleme adımı akış hata verse ya da süre aşılsa bile her durumda çalışır (`finally`).

**Özet önce:** Özet ekranında UCP özeti (1–3 sn'de gelir) en üstte gösterilir. "Ödeme sayfasını aç" butonu affiliate hazırlığı bitene kadar "Hazırlanıyor… N sn" olarak bekler; süre sınırından sonra her durumda açılır. Kullanıcı bu sürede özeti okur.

## Açılış seçenekleri

| Seçenek | Nasıl |
| --- | --- |
| Uygulama içi tarayıcı | `WebBrowser.openBrowserAsync` (iOS: Safari paneli, Android: Custom Tabs) |
| Görünür WebView | Hazırlık için kullanılan **aynı** WebView tam ekran olur. Çerezler (gizli modda da) korunur. Adreste `thank-you` / `thank_you` görülürse günlüğe işlenir. |
| Dış tarayıcı | `Linking.openURL` (Safari / varsayılan tarayıcı) |

## Ayarlar

Ödeme modu, açılış, `sca_ref` ekle (Mod C), kimlik yazılmazsa davranış, WebView çerez deposu (kalıcı / gizli), Mod B ödeme adresi, sunucu adresi, mağaza, ref kodu, ürün handle, varyantlar (M/52 `47830495691066`, L/52 `47830495854906`), alıcı (test verisi), bekleme süreleri (8 sn / 15 sn). Hepsi telefonda saklanır.

## Test günlüğü

**Günlük** sekmesi her denemeyi şu bilgilerle tutar:
- benzersiz deneme numarası (`KAUNA-ATT-…`, UCP `attribution.utm_content` ile aynı)
- platform, mod, açılış seçeneği
- maskeli checkout kimliği
- adım süreleri: UCP, ana sayfa, ref sayfası, `_up_click_id`, toplam
- token eşleşmeleri, `_up_click_id`, önceki sepetin geri yüklenmesi
- UCP mesajları ve kimlik yolu
- elle girilenler: ön doldurma, hızlı ödeme butonları, notlar

**Markdown paylaş / CSV paylaş** sistem paylaşım menüsünü açar.

## Test senaryoları

| # | Ayar | Ne kontrol edilir |
| --- | --- | --- |
| 1 | A · uygulama içi | Özet + ön doldurulmuş ödeme sayfası; “affiliate yok” notu |
| 2 | C · uygulama içi · sca_ref açık · kalıcı | Token eşleşmeleri, `_up_click_id` süresi, önceki sepet geri yüklendi mi |
| 3 | C · gizli çerez deposu | Temiz oturumda aynı ölçümler |
| 4 | C · görünür WebView | Hızlı ödeme butonları (Apple Pay / Google Pay / Shop Pay) WebView'da görünüyor mu |
| 5 | C · dış tarayıcı | Safari/Chrome'a tohum bırakma; ödeme sayfası dolu mu |
| 6 | C · kimlik gelmezse D/B/dur | Bekleme süresini 1000 ms'ye düşürüp düşüş davranışını gözleyin |
| 7 | B · /cart/c ve /checkout (WebView) | Ön doldurma; adres çubuğunda kişisel bilgi |
| 8 | D · her açılış | Sipariş testinde pikselin Kauna'ya yazıp yazmadığı (marka ile) |

Her denemeden sonra **Özet** ekranındaki “Gözlem” kutusunu doldurup **Günlüğe kaydet**'e basın.

## Doğrulama durumu

- TypeScript temiz. `expo export` ile Android ve iOS paketleri çevrimdışı üretildi (608 modül). expo-doctor 19/21 geçti; kalan 2 kontrol Expo sunucularına erişim gerektiriyor ve bu ortamda engelli.
- Sayfa içi adımlar, uygulamadaki **aynı** betiklerle sahte mağazaya karşı Chromium'da çalıştırıldı (`scripts/mock-ucp-server.mjs` içindeki vitrin + UpPromote benzeri test betiği). Mod C: çerez bağlama, kimlik yazımı, token korunması, geri yükleme ve önceki sepet yokken silme ✓. Mod B: kimlik, ekleme, token biçimi ✓.
- **Gerçek telefonda ve gerçek AAB mağazasında henüz denenmedi.** İlk gerçek sonuçları `FINDINGS.md`'ye ekleyin.
