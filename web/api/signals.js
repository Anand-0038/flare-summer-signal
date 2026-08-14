import { fetchFassetSnapshot, resolveRpcUrl } from '../src/lib/fassets.js'

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

  try {
    const snapshot = await fetchFassetSnapshot({
      rpcUrl: resolveRpcUrl(),
    })

    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.status(200).json(snapshot)
  } catch (error) {
    console.error('FAsset signal read failed', error)
    response.status(503).json({
      error: 'LIVE_DATA_UNAVAILABLE',
      message: 'Coston2 data could not be read. No fallback snapshot is served.',
    })
  }
}
