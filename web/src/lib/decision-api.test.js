import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDecisionParams } from './decision-api.js'

test('decision API accepts a supported operation and whole-lot size', () => {
  const params = parseDecisionParams(
    new URLSearchParams('operation=mint_fxrp&lots=100'),
  )

  assert.deepEqual(params, { operation: 'mint_fxrp', lots: '100' })
})

test('decision API rejects unsupported operations and fractional lots', () => {
  const operation = parseDecisionParams(new URLSearchParams('operation=trade&lots=1'))
  const lots = parseDecisionParams(new URLSearchParams('operation=accept_fxrp&lots=1.5'))

  assert.equal(operation.error, 'INVALID_OPERATION')
  assert.equal(lots.error, 'INVALID_LOTS')
})

test('decision API trims whitespace in operation and lots input', () => {
  const params = parseDecisionParams(new URLSearchParams('operation= %20accept_fxrp%20&lots=%20100%20'))
  assert.deepEqual(params, { operation: 'accept_fxrp', lots: '100' })
})
