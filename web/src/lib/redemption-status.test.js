import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRedemptionStatusParams,
  summarizeRequestStatus,
  findRedemptionRequestById,
} from './redemption-status.js'

test('status API rejects missing lookup input', () => {
  const params = parseRedemptionStatusParams(new URLSearchParams(''))
  assert.equal(params.error, 'INVALID_INPUT')
})

test('status API requires fromBlock when looking up by requestId only', () => {
  const params = parseRedemptionStatusParams(new URLSearchParams('requestId=123'))
  assert.equal(params.error, 'REQUEST_ID_REQUIRES_FROM_BLOCK')
})

test('status API reports invalid requestId before fromBlock requirement', () => {
  const params = parseRedemptionStatusParams(new URLSearchParams('requestId=xyz'))
  assert.equal(params.error, 'INVALID_REQUEST_ID')
})

test('status API treats whitespace as missing fromBlock in requestId-only mode', () => {
  const params = parseRedemptionStatusParams(new URLSearchParams('requestId=123&fromBlock=   '))
  assert.equal(params.error, 'REQUEST_ID_REQUIRES_FROM_BLOCK')
})

test('status API rejects invalid requestId with explicit error', () => {
  const params = parseRedemptionStatusParams(
    new URLSearchParams('requestId=xyz&tx=0x' + 'ab'.repeat(32)),
  )
  assert.equal(params.error, 'INVALID_REQUEST_ID')
})

test('status API rejects invalid fromBlock value', () => {
  const params = parseRedemptionStatusParams(new URLSearchParams('requestId=123&fromBlock=bad'))
  assert.equal(params.error, 'INVALID_FROM_BLOCK')
})

test('status API rejects invalid toBlock value', () => {
  const params = parseRedemptionStatusParams(new URLSearchParams(`requestId=123&fromBlock=10&toBlock=bad`))
  assert.equal(params.error, 'INVALID_TO_BLOCK')
})

test('status API rejects a reversed requestId scan range', () => {
  const params = parseRedemptionStatusParams(
    new URLSearchParams('requestId=123&fromBlock=1200&toBlock=1199'),
  )
  assert.equal(params.error, 'INVALID_BLOCK_RANGE')
})

test('status API accepts a bounded request-id lookup', () => {
  const params = parseRedemptionStatusParams(
    new URLSearchParams('requestId=123&fromBlock=1000&toBlock=1200'),
  )
  assert.equal(params.requestId, '123')
  assert.equal(params.fromBlock, 1000n)
  assert.equal(params.toBlock, 1200n)
})

test('status API accepts requestId in hex form', () => {
  const params = parseRedemptionStatusParams(
    new URLSearchParams('requestId=0x2a&tx=0x' + 'ab'.repeat(32) + '&fromBlock=1'),
  )
  assert.equal(params.requestId, '42')
  assert.equal(params.tx, '0x' + 'ab'.repeat(32))
})

test('status API accepts requestId in requestId mode with uppercase hex prefix', () => {
  const params = parseRedemptionStatusParams(
    new URLSearchParams('requestId=0X2A&fromBlock=100'),
  )
  assert.equal(params.requestId, '42')
  assert.equal(params.fromBlock, 100n)
  assert.equal(params.toBlock, null)
})

test('status API treats whitespace toBlock as optional', () => {
  const params = parseRedemptionStatusParams(
    new URLSearchParams('requestId=123&fromBlock=100&toBlock=   '),
  )
  assert.equal(params.error, undefined)
  assert.equal(params.toBlock, null)
})

test('status API accepts hexadecimal requestId with uppercase 0X prefix', () => {
  const params = parseRedemptionStatusParams(
    new URLSearchParams('requestId=0X2a&tx=0x' + 'ab'.repeat(32) + '&fromBlock=1'),
  )
  assert.equal(params.requestId, '42')
  assert.equal(params.tx, '0x' + 'ab'.repeat(32))
})

test('status API accepts a checksum-valid tx hash with optional requestId', () => {
  const tx = '0x' + 'ab'.repeat(32)
  const params = parseRedemptionStatusParams(new URLSearchParams(`tx=${tx}&requestId=456`))
  assert.equal(params.tx, tx)
  assert.equal(params.requestId, '456')
})

test('status API rejects the all-zero tx hash in tx mode', () => {
  const params = parseRedemptionStatusParams(
    new URLSearchParams(`tx=${'0x'.concat('0'.repeat(64))}`),
  )
  assert.equal(params.error, 'INVALID_TX_HASH')
})

test('status API accepts an uppercase 0X tx hash prefix', () => {
  const tx = '0X' + 'AB'.repeat(32)
  const params = parseRedemptionStatusParams(new URLSearchParams(`tx=${tx}`))
  assert.equal(params.error, undefined)
  assert.equal(params.tx, tx.toLowerCase())
})

test('status API ignores request window params when tx mode is used', () => {
  const tx = '0x' + 'ab'.repeat(32)
  const params = parseRedemptionStatusParams(new URLSearchParams(`tx=${tx}&fromBlock=bad&toBlock=bad`))
  assert.equal(params.error, undefined)
  assert.equal(params.tx, tx)
  assert.equal(params.fromBlock, null)
  assert.equal(params.toBlock, null)
})

test('status API rejects malformed tx even when requestId lookup params are present', () => {
  const params = parseRedemptionStatusParams(
    new URLSearchParams('tx=0xbad&requestId=123&fromBlock=100'),
  )
  assert.equal(params.error, 'INVALID_TX_HASH')
})

test('status evaluation reports completed when RedemptionPerformed exists', () => {
  const status = summarizeRequestStatus(
    {
      lastUnderlyingTimestamp: '1700000000',
    },
    {
      performed: true,
      defaulted: false,
    },
    1699999000,
  )

  assert.equal(status.code, 'COMPLETED')
  assert.equal(status.label, 'Payment observed')
})

test('status evaluation reports deadline-open and remaining seconds by timestamp', () => {
  const status = summarizeRequestStatus(
    {
      lastUnderlyingTimestamp: '1700001000',
    },
    {
      performed: false,
      defaulted: false,
    },
    1700000000,
  )

  assert.equal(status.code, 'DEADLINE_OPEN')
  assert.equal(status.reasonCodes.includes('PAYMENT_DEADLINE_OPEN'), true)
})

test('status evaluation reports deadline elapsed when no payment is observed', () => {
  const status = summarizeRequestStatus(
    {
      lastUnderlyingTimestamp: '1700000000',
    },
    {
      performed: false,
      defaulted: false,
    },
    1700000100,
  )

  assert.equal(status.code, 'DEADLINE_ELAPSED')
  assert.equal(status.label, 'Deadline elapsed')
})

test('status evaluation treats exact deadline as elapsed', () => {
  const status = summarizeRequestStatus(
    {
      lastUnderlyingTimestamp: '1700000000',
    },
    {
      performed: false,
      defaulted: false,
    },
    1700000000,
  )

  assert.equal(status.code, 'DEADLINE_ELAPSED')
  assert.equal(status.reasonCodes.includes('PAYMENT_DEADLINE_ELAPSED'), true)
})

test('status evaluation rejects malformed deadline timestamp', () => {
  const status = summarizeRequestStatus(
    {
      lastUnderlyingTimestamp: 'invalid',
    },
    {
      performed: false,
      defaulted: false,
    },
    1700000000,
  )

  assert.equal(status.code, 'UNKNOWN')
  assert.equal(status.reasonCodes.includes('PAYMENT_DEADLINE_INVALID'), true)
})

test('status evaluation invalidates non-safe deadline durations', () => {
  const veryLargeDeadline = (2n ** 60n).toString()
  const status = summarizeRequestStatus(
    {
      lastUnderlyingTimestamp: veryLargeDeadline,
    },
    {
      performed: false,
      defaulted: false,
    },
    0,
  )

  assert.equal(status.code, 'UNKNOWN')
  assert.equal(status.reasonCodes.includes('PAYMENT_DEADLINE_INVALID'), true)
})

test('status lookup rejects requestId ranges that start after latest chain block', async () => {
  const result = await findRedemptionRequestById(
    {
      getBlockNumber: async () => 10n,
      getLogs: async () => [],
    },
    '0x1111111111111111111111111111111111111111',
    '1',
    20n,
    null,
  )

  assert.equal(result.error, 'INVALID_SCAN_RANGE')
})
