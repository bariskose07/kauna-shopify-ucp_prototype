'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

// Minimal stroke icons (inline SVG — no icon font / external asset).
const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)
const ICONS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
  bag: 'M5 8h14l-1 12H6L5 8zM9 8V6a3 3 0 0 1 6 0v2',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4',
  debug: 'M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12',
}

const LINKS = [
  { href: '/', label: 'Keşfet', icon: ICONS.search },
  { href: '/cart', label: 'Sepet', icon: ICONS.bag },
  { href: '/settings', label: 'Ayarlar', icon: ICONS.settings },
  { href: '/debug', label: 'Hata ayıklama', icon: ICONS.debug },
]

export function Header() {
  const path = usePathname()
  const [count, setCount] = useState(0)

  // Cart badge: refreshed on every navigation (cheap: local session only).
  useEffect(() => {
    fetch('/api/cart', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { carts?: { lineItems: { quantity: number }[] }[] }) =>
        setCount((j.carts ?? []).reduce((a, c) => a + c.lineItems.reduce((b, l) => b + l.quantity, 0), 0)),
      )
      .catch(() => {})
  }, [path])

  return (
    <header className="header">
      <div className="header-inner">
        <Link href="/" className="brand">
          kauna<small>UCP test</small>
        </Link>
        {LINKS.map((l) => {
          const active = l.href === '/' ? path === '/' || path.startsWith('/product') : path.startsWith(l.href)
          return (
            <Link key={l.href} href={l.href} className={`navlink ${active ? 'active' : ''}`} aria-label={l.label}>
              <Icon d={l.icon} />
              <span className="label">{l.label}</span>
              {l.href === '/cart' && count > 0 && <span className="count">{count}</span>}
            </Link>
          )
        })}
      </div>
    </header>
  )
}
