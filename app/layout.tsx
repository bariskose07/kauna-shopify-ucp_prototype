import type { Metadata, Viewport } from 'next'

import { AuthStatus } from '@/components/AuthStatus'
import { Header } from '@/components/Header'

import './globals.css'

export const metadata: Metadata = {
  title: 'Kauna × Shopify UCP (TEST)',
  description: 'In-app checkout prototype on Shopify UCP. Never completes orders.',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f4ef' },
    { media: '(prefers-color-scheme: dark)', color: '#141210' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>
        <div className="topbar">
          {/* Rule 1: visible on every page. */}
          <div className="test-banner" role="alert">
            TEST – Ödemeyi tamamlama, gerçek sipariş verilir. Mağaza sayfasında “Pay now / Siparişi tamamla”ya basma.
          </div>
          <Header />
          <AuthStatus />
        </div>
        <main>{children}</main>
      </body>
    </html>
  )
}
