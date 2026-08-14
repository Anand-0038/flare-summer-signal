import {
  fetchRedemptionPlanPayload,
  parseRedemptionPlanParams,
} from '../src/lib/redemption-api.js'
import { resolveRpcUrl } from '../src/lib/fassets.js'
import { parseSearchParamsOrErrorResponse } from '../src/lib/request-params.js'

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET')
  response.setHeader('Cache-Control', 'no-store')

  if (request.method === 'OPTIONS') {
    response.status(204).end()
    return
  }

  if (request.method !== 'GET') {
    response.status(405).json({ error: 'METHOD_NOT_ALLOWED' })
    return
  }

  const searchParams = parseSearchParamsOrErrorResponse(request, response)
  if (!searchParams) return

  const params = parseRedemptionPlanParams(searchParams)
  if (params.error) {
    response.status(400).json(params)
    return
  }

  try {
    const payload = await fetchRedemptionPlanPayload({
      rpcUrl: resolveRpcUrl(),
      lots: params.lots,
      account: params.account,
      underlyingAddress: params.underlyingAddress,
      destinationTag: params.destinationTag,
    })

    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.status(200).json(payload)
  } catch (error) {
    console.error('FAsset redemption transaction plan failed', error)
    response.status(503).json({
      error: 'LIVE_DATA_UNAVAILABLE',
      message: 'Coston2 data could not be read or simulated. No fallback transaction plan is served.',
    })
  }
}
