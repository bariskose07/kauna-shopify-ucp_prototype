import { NextResponse } from 'next/server'

import { config } from '@/lib/ucp/client'

export const dynamic = 'force-dynamic'

// Non-secret runtime configuration for the settings page.
export async function GET() {
  const c = config()
  return NextResponse.json({
    transport: c.transport,
    auth: c.transport === 'cli' ? 'ucp-cli' : c.hasClientCredentials ? 'client-credentials-bearer' : 'agent-profile-only',
    profileOverride: c.profileOverride ?? null,
    catalogUrl: c.catalogUrl,
    catalogEndpoint: c.catalogEndpoint ?? null,
    catalogId: c.catalogId ? 'set' : null,
    defaultSeller: c.defaultSeller,
  })
}
