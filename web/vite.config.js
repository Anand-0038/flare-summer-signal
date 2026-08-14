import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fetchFassetSnapshot, resolveRpcUrl } from './src/lib/fassets.js'
import { fetchDecisionPayload, parseDecisionParams } from './src/lib/decision-api.js'
import {
  fetchRedemptionPayload,
  fetchRedemptionPlanPayload,
  parseRedemptionParams,
  parseRedemptionPlanParams,
} from './src/lib/redemption-api.js'
import { fetchRedemptionStatusPayload, parseRedemptionStatusParams } from './src/lib/redemption-status.js'

function attachSignalsApi(server) {
  const applySuccessHeaders = (response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
  }

  const respondMethodNotAllowed = (response) => {
    applySuccessHeaders(response)
    response.statusCode = 405
    response.setHeader('Allow', 'GET')
    response.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }))
  }

  server.middlewares.use('/api/signals.json', async (request, response) => {
    applySuccessHeaders(response)

    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.end()
      return
    }

    if (request.method !== 'GET') {
      respondMethodNotAllowed(response)
      return
    }

    try {
      const snapshot = await fetchFassetSnapshot({ rpcUrl: resolveRpcUrl() })
      response.statusCode = 200
      response.end(JSON.stringify(snapshot))
    } catch (error) {
      console.error('FAsset signal read failed', error)
      response.statusCode = 503
      response.end(
        JSON.stringify({
          error: 'LIVE_DATA_UNAVAILABLE',
          message: 'Coston2 data could not be read. No fallback snapshot is served.',
        }),
      )
    }
  })

  server.middlewares.use('/api/decision.json', async (request, response) => {
    applySuccessHeaders(response)

    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.end()
      return
    }

    if (request.method !== 'GET') {
      respondMethodNotAllowed(response)
      return
    }

    const url = new URL(request.url || '/', 'http://localhost')
    const params = parseDecisionParams(url.searchParams)
    if (params.error) {
      response.statusCode = 400
      response.end(JSON.stringify(params))
      return
    }

    try {
      const payload = await fetchDecisionPayload({
        rpcUrl: resolveRpcUrl(),
        operation: params.operation,
        lots: params.lots,
      })
      response.statusCode = 200
      response.end(JSON.stringify(payload))
    } catch (error) {
      console.error('FAsset Guardian decision failed', error)
      response.statusCode = 503
      response.end(
        JSON.stringify({
          error: 'LIVE_DATA_UNAVAILABLE',
          message: 'Coston2 data could not be read. No fallback decision is served.',
        }),
      )
    }
  })

  server.middlewares.use('/api/redemption.json', async (request, response) => {
    applySuccessHeaders(response)

    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.end()
      return
    }

    if (request.method !== 'GET') {
      respondMethodNotAllowed(response)
      return
    }

    const url = new URL(request.url || '/', 'http://localhost')
    const params = parseRedemptionParams(url.searchParams)
    if (params.error) {
      response.statusCode = 400
      response.end(JSON.stringify(params))
      return
    }

    try {
      const payload = await fetchRedemptionPayload({
        rpcUrl: resolveRpcUrl(),
        lots: params.lots,
      })
      response.statusCode = 200
      response.end(JSON.stringify(payload))
    } catch (error) {
      console.error('FAsset redemption preview failed', error)
      response.statusCode = 503
      response.end(
        JSON.stringify({
          error: 'LIVE_DATA_UNAVAILABLE',
          message: 'Coston2 data could not be read. No fallback redemption preview is served.',
        }),
      )
    }
  })

  server.middlewares.use('/api/redemption-plan.json', async (request, response) => {
    applySuccessHeaders(response)

    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.end()
      return
    }

    if (request.method !== 'GET') {
      respondMethodNotAllowed(response)
      return
    }

    const url = new URL(request.url || '/', 'http://localhost')
    const params = parseRedemptionPlanParams(url.searchParams)
    if (params.error) {
      response.statusCode = 400
      response.end(JSON.stringify(params))
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
      response.statusCode = 200
      response.end(JSON.stringify(payload))
    } catch (error) {
      console.error('FAsset redemption transaction plan failed', error)
      response.statusCode = 503
      response.end(
        JSON.stringify({
          error: 'LIVE_DATA_UNAVAILABLE',
          message: 'Coston2 data could not be read or simulated. No fallback transaction plan is served.',
        }),
      )
    }
  })

  server.middlewares.use('/api/redemption-status.json', async (request, response) => {
    applySuccessHeaders(response)

    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.end()
      return
    }

    if (request.method !== 'GET') {
      respondMethodNotAllowed(response)
      return
    }

    const url = new URL(request.url || '/', 'http://localhost')
    const params = parseRedemptionStatusParams(url.searchParams)
    if (params.error) {
      response.statusCode = 400
      response.end(JSON.stringify(params))
      return
    }

    try {
      const payload = await fetchRedemptionStatusPayload({
        rpcUrl: resolveRpcUrl(),
        tx: params.tx,
        requestId: params.requestId,
        fromBlock: params.fromBlock,
        toBlock: params.toBlock,
      })
      if (payload.error) {
        response.statusCode = 400
        response.end(JSON.stringify(payload))
        return
      }

      response.statusCode = 200
      response.end(JSON.stringify(payload))
    } catch (error) {
      console.error('FAsset redemption status failed', error)
      response.statusCode = 503
      response.end(
        JSON.stringify({
          error: 'LIVE_DATA_UNAVAILABLE',
          message: 'Coston2 data could not be read. No fallback request status is served.',
        }),
      )
    }
  })
}

function liveSignalsApi() {
  return {
    name: 'live-fasset-signals-api',
    configureServer: attachSignalsApi,
    configurePreviewServer: attachSignalsApi,
  }
}

export default defineConfig({
  plugins: [react(), liveSignalsApi()],
  server: { port: 5178 },
})
