import type { Metadata, Viewport } from 'next'
import Link from 'next/link'

import './globals.css'

export const metadata: Metadata = {
  title: 'Kauna × Shopify UCP (TEST)',
  description: 'In-app checkout prototype on Shopify UCP. Never completes orders.',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>
        {/* Rule 1: visible on every page. */}
        <div className="test-banner" role="alert">
          TEST – Ödemeyi tamamlama, gerçek sipariş verilir. Mağaza sayfasında “Siparişi tamamla / Pay now”a basma.
        </div>
        <nav className="nav">
          <Link href="/" className="brand">
            kauna · UCP
          </Link>
          <Link href="/">Arama</Link>
          <Link href="/cart">Sepet</Link>
          <Link href="/settings">Ayarlar</Link>
          <Link href="/debug">Hata ayıklama</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  )
}
