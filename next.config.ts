import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Product images are rendered with plain <img> straight from Shopify's CDN
  // URLs (Catalog terms: no server-side caching/proxying of Catalog media), so
  // next/image optimisation is intentionally NOT used.
  images: { unoptimized: true },
  // Allow opening the dev server from a phone on the same Wi-Fi / via a tunnel.
  allowedDevOrigins: ['*.local', '192.168.*.*', '10.*.*.*', '*.ngrok-free.app', '*.trycloudflare.com'],
}

export default nextConfig
