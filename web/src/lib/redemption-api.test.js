import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRedemptionParams } from './redemption-api.js'

test('redemption API accepts a whole-lot request', () => {
  assert.deepEqual(
    parseRedemptionParams(new URLSearchParams('lots=100')),
    { lots: '100' },
  )
})

test('redemption API rejects fractional or zero lots', () => {
  const fractional = parseRedemptionParams(new URLSearchParams('lots=1.5'))
  const zero = parseRedemptionParams(new URLSearchParams('lots=0'))

  assert.equal(fractional.error, 'INVALID_LOTS')
  assert.equal(zero.error, 'INVALID_LOTS')
})

test('redemption API trims whitespace around lots input', () => {
  const params = parseRedemptionParams(new URLSearchParams('lots=%2010%20'))
  assert.deepEqual(params, { lots: '10' })
})
