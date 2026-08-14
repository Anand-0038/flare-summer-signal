import test from 'node:test'
import assert from 'node:assert/strict'

import { parseSearchParams, parseSearchParamsOrErrorResponse } from './request-params.js'

test('parseSearchParams reads valid query strings', () => {
  const params = parseSearchParams('/api/redemption-status.json?tx=0x123&fromBlock=10')
  assert.ok(params instanceof URLSearchParams)
  assert.equal(params.get('tx'), '0x123')
  assert.equal(params.get('fromBlock'), '10')
})

test('parseSearchParams preserves raw percent values instead of throwing', () => {
  const params = parseSearchParams('/api/redemption-status.json?tx=%')
  assert.ok(params instanceof URLSearchParams)
  assert.equal(params.get('tx'), '%')
})

test('parseSearchParamsOrErrorResponse writes a 400 response for malformed URLs', () => {
  const response = {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.payload = body
      return this
    },
  }

  const params = parseSearchParamsOrErrorResponse({ url: 'http://%' }, response)

  assert.equal(params, null)
  assert.equal(response.statusCode, 400)
  assert.equal(response.payload.error, 'INVALID_REQUEST_URL')
  assert.match(response.payload.message, /valid, encoded request/)
})
