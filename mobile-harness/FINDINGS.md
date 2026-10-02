# Mobil test bulguları

Durum: kod tamam, **gerçek cihaz / gerçek mağaza ölçümleri henüz yok**. Aşağıdaki tablolar telefonla yapılacak denemelerle doldurulacak. Uygulamanın Günlük sekmesindeki **Markdown paylaş** çıktısı doğrudan buraya yapıştırılabilir.

## 1. Bu ortamda doğrulananlar (sahte mağaza)

| Kontrol | Sonuç |
| --- | --- |
| `POST /api/mobile/ucp-checkout` tek istekte adresli checkout | ✓ (`create_checkout` içinde teslimat; `requires_escalation`) |
| `id` → `cartToken` + 32 karakter `cartKey` ayrıştırma | ✓ |
| Sunucu logunda anahtarların maskelenmesi | ✓ (`cart=hWNebd… key=a7aed6…`) |
| Mod C: önceki çerez okundu → UCP sepetine ayarlandı → `/cart.js` token = UCP | ✓ |
| Mod C: ref'li sayfadan sonra `_up_click_id` UCP sepetinde, token değişmedi | ✓ (~1 sn; sahte mağazada) |
| Mod C: önceki sepet geri yüklendi / önceki yoksa çerez silindi | ✓ / ✓ |
| Mod B: `_up_click_id` → `/cart/add.js` → `xxx?key=yyy` token | ✓ |
| Web prototipi: derleme + 56 uçtan uca kontrol + 42 birim testi | ✓ |

Sahte mağazadaki “UpPromote” yalnızca test için yazılmış basit bir betik (sayfa `?sca_ref` ile açılınca sepete bir kimlik yazıyor). **Gerçek UpPromote davranışını kanıtlamaz**; yalnızca uygulamanın adım mantığını doğrular.

## 2. Ölçülecekler (gerçek cihaz)

### Hazırlık süreleri (ms)

| Platform | Mod | Çerez | UCP | Ana sayfa | Ref sayfa | `_up_click_id` | Toplam |
| --- | --- | --- | --- | --- | --- | --- | --- |
| iOS | C | kalıcı | | | | | |
| iOS | C | gizli | | | | | |
| Android | C | kalıcı | | | | | |
| Android | B | kalıcı | | | | | |

### `_up_click_id` güvenilirliği
10 denemede kaç kez 8 sn içinde geldi? Mod C'de ref sonrası token UCP sepetiyle aynı kaldı mı?

### Hızlı ödeme butonları

| Açılış | iOS | Android |
| --- | --- | --- |
| Uygulama içi tarayıcı | | |
| Görünür WebView | | |
| Dış tarayıcı | | |

## 3. Açık riskler ve gözlemlenecek noktalar

1. **`cart` çerezinin alan adı.** Mağaza `cart` çerezini `Domain=.us.aabcollection.com` ile kurmuşsa, `document.cookie` ile yazdığımız host-only çerez ikinci bir çerez olarak eklenebilir. Bu durumda mağaza hangisini okuyacağını kendisi seçer. Uygulama bunu `/cart.js` token kontrolüyle yakalıyor (çerez sonrası ve ref sonrası). Uyuşmazlık olursa akış durur ve önceki değer geri yazılır. Gerçek mağazada gözlenmeli.
2. **Geri yükleme garantisi.** Önceki değer geri yazılıyor. Ancak mağaza aynı anda `Set-Cookie` ile çerezi yenilerse, geri yüklenen değer üzerine yazılabilir. “Önceki sepet geri yüklendi” alanı her denemede kontrol edilmeli.
3. **Mod B'de kişisel bilgi adres çubuğunda.** `checkout[email]`, `checkout[shipping_address][...]` parametreleri URL'de taşınıyor. Tarayıcı geçmişine, sunucu loglarına ve sayfa referans başlıklarına geçebilir. Yalnızca test verisi kullanın; üretimde bu yol önerilmez. Uygulama günlükte bu değerleri maskeler.
4. **Mod B'nin C'ye düşüş olarak kullanılması.** Bu durumda kullanıcının **kendi** mağaza sepetine ürün eklenir (Mod B'nin doğası). Kauna içinde kalıcı bir mağaza sepeti varsa ürün orada kalır.
5. **iOS uygulama içi tarayıcı (SFSafariViewController)** Safari ile çerez paylaşmaz. `sca_ref`'li açılışın 30 günlük “tohumu” Safari'ye geçmez. Android Custom Tabs ise Chrome ile paylaşır. Ölçülmeli.
6. **Görünür WebView ve hızlı ödeme.** Apple Pay ve Google Pay WebView'da genellikle kısıtlıdır. Hangi butonların göründüğü ölçülmeli.
7. **İlişki / izin.** Mod C, mağazanın sepet çerezini belgelenmemiş bir şekilde kullanır. Siparişin UpPromote'ta Kauna'ya yazıldığı doğrulansa bile, üretimden önce yöntem AAB (ve gerekirse UpPromote) ile paylaşılıp onayları alınmalı. Mağaza tema/uygulama güncellemeleri davranışı değiştirebilir.
8. **Hız limitleri.** Her deneme en az bir Checkout MCP isteği harcar (anonim katmanda ~1 saatlik 429 gözlendi). Art arda çok deneme yapmayın; limit varsa Özet ekranında `Retry-After` görünür.
9. **Henüz doğrulanmayan tek kritik konu.** Bu yollarla verilen bir siparişin UpPromote panelinde Kauna'ya yazılıp yazılmadığı. Markayla yapılacak gerçek test siparişlerinde deneme numarası (`utm_content`) ve saat ile eşleştirin.

## 4. Kimlik katmanlarının kaynağı

Shopify'ın token / imzalı / anonim katmanları ve limitleri: <https://shopify.dev/docs/agents/profiles/auth-and-rate-limiting> (ayrıca <https://shopify.dev/docs/agents/get-started/authentication>). Bu sayfalar geliştirme ortamından açılamadı; içerik arama özetlerinden alındı. Ayrıntı: kök `FINDINGS.md` §10.
