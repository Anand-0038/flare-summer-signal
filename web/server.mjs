import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import decisionHandler from './api/decision.js'
import redemptionHandler from './api/redemption.js'
import redemptionPlanHandler from './api/redemption-plan.js'
import redemptionStatusHandler from './api/redemption-status.js'
import signalsHandler from './api/signals.js'

const SERVER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIRECTORY = path.join(SERVER_DIRECTORY, 'dist')
const HOST = '0.0.0.0'
const DEFAULT_PORT = 5178

const API_HANDLERS = new Map([
  ['/api/decision.json', decisionHandler],
  ['/api/redemption.json', redemptionHandler],
  ['/api/redemption-plan.json', redemptionPlanHandler],
  ['/api/redemption-status.json', redemptionStatusHandler],
  ['/api/signals.json', signalsHandler],
])

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

function responseAdapter(response) {
  const adapter = {
    setHeader(name, value) {
      response.setHeader(name, value)
      return adapter
    },
    status(code) {
      response.statusCode = code
      return adapter
    },
    json(body) {
      if (!response.hasHeader('Content-Type')) {
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
      }
      response.end(JSON.stringify(body))
      return adapter
    },
    end(body) {
      response.end(body)
      return adapter
    },
  }

  return adapter
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

function requestPath(requestUrl) {
  try {
    return new URL(requestUrl || '/', 'http://fasset-guardian.invalid').pathname
  } catch {
    return null
  }
}

function safeStaticPath(pathname) {
  let decodedPath
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '')
  const candidate = path.resolve(DIST_DIRECTORY, relativePath)
  const directoryPrefix = `${DIST_DIRECTORY}${path.sep}`
  if (candidate !== DIST_DIRECTORY && !candidate.startsWith(directoryPrefix)) {
    return null
  }

  return candidate
}

async function serveStatic(request, response, pathname) {
  const candidate = safeStaticPath(pathname)
  if (!candidate) {
    sendJson(response, 400, { error: 'INVALID_PATH' })
    return
  }

  let filePath = candidate
  let contents
  try {
    contents = await readFile(filePath)
  } catch (error) {
    if (path.extname(pathname)) {
      sendJson(response, 404, { error: 'NOT_FOUND' })
      return
    }

    filePath = path.join(DIST_DIRECTORY, 'index.html')
    try {
      contents = await readFile(filePath)
    } catch {
      console.error('Static build output is unavailable', error)
      sendJson(response, 500, { error: 'STATIC_BUILD_UNAVAILABLE' })
      return
    }
  }

  const extension = path.extname(filePath).toLowerCase()
  response.statusCode = 200
  response.setHeader('Content-Type', CONTENT_TYPES.get(extension) || 'application/octet-stream')
  response.setHeader(
    'Cache-Control',
    pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  )
  if (request.method === 'HEAD') {
    response.end()
    return
  }

  response.end(contents)
}

async function handleRequest(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')

  const pathname = requestPath(request.url)
  if (!pathname) {
    sendJson(response, 400, { error: 'INVALID_REQUEST_URL' })
    return
  }

  if (pathname === '/health') {
    sendJson(response, 200, { ok: true, service: 'fasset-guardian' })
    return
  }

  const handler = API_HANDLERS.get(pathname)
  if (handler) {
    await handler(
      {
        method: request.method,
        url: request.url,
        headers: request.headers,
      },
      responseAdapter(response),
    )
    return
  }

  if (pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'NOT_FOUND' })
    return
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD')
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    return
  }

  await serveStatic(request, response, pathname)
}

function parsePort(value) {
  const port = Number(value || DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`)
  }
  return port
}

const port = parsePort(process.env.PORT)
const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error('Unhandled server request failure', error)
    if (!response.headersSent) {
      sendJson(response, 500, { error: 'INTERNAL_SERVER_ERROR' })
    } else if (!response.writableEnded) {
      response.end()
    }
  })
})

server.listen(port, HOST, () => {
  console.log(`FAsset Guardian listening on ${HOST}:${port}`)
})

function closeServer(signal) {
  console.log(`${signal} received; closing FAsset Guardian`)
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => closeServer('SIGTERM'))
process.on('SIGINT', () => closeServer('SIGINT'))
