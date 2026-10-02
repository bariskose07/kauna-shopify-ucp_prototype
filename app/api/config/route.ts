import { NextResponse } from 'next/server'

import { MCP_PROTOCOL_VERSION, config, getAuthSettings, profileStatus } from '@/lib/ucp/client'

export const dynamic = 'force-dynamic'

// Non-secret runtime configuration for the settings page.
export async function GET() {
  const c = config()
  return NextResponse.json({
    transport: c.transport,
    auth: c.transport === 'cli' ? 'ucp-cli (test)' : c.hasClientCredentials ? 'client-credentials-bearer' : 'kimlik bilgisi yok',
    profileOverride: c.profileOverride ?? null,
    profiles: profileStatus(),
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    settings: getAuthSettings(),
    catalogUrl: c.catalogUrl,
    catalogEndpoint: c.catalogEndpoint ?? null,
    catalogId: c.catalogId ? 'set' : null,
    defaultSeller: c.defaultSeller,
  })
}
