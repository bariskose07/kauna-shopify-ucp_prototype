import { NextResponse } from 'next/server'

import { badRequest, errorJson } from '@/lib/api'
import { normalizeSeller } from '@/lib/session'
import { schemaFacts } from '@/lib/ucp/checkout'
import { discover, getInputSchema, offeredTools } from '@/lib/ucp/client'

export const dynamic = 'force-dynamic'

// What does this business support, and where does it want each field?
export async function GET(req: Request) {
  const seller = new URL(req.url).searchParams.get('seller')
  if (!seller) return badRequest('seller gerekli')
  try {
    const business = normalizeSeller(seller)
    const d = await discover(business, true)
    const tools = await offeredTools(business)
    let facts: unknown = null
    if (tools.includes('update_checkout')) facts = schemaFacts(await getInputSchema(business, 'update_checkout'), 'update')
    return NextResponse.json({
      business: d.business,
      version: d.version,
      source: d.source,
      endpoint: d.endpoint,
      businessProfileUrl: d.businessProfileUrl,
      agentProfileUrl: d.agentProfileUrl,
      capabilities: d.capabilities,
      payment_handlers: d.paymentHandlers,
      tools,
      checkoutSchemaFacts: facts,
    })
  } catch (e) {
    return errorJson(e)
  }
}
