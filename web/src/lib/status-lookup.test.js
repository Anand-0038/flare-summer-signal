import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStatusLookupParams,
  normalizeTransactionLookupHash,
  normalizeRequestIdLookup,
  parseLookupBlock,
} from './status-lookup.js'

test('status lookup builder accepts a valid tx-only request', () => {
  const tx = '0x' + 'ab'.repeat(32)
  const prepared = buildStatusLookupParams({ mode: 'tx', tx })
  assert.equal(prepared.error, undefined)
  assert.equal(prepared.query, `tx=${tx}`)
})

test('status lookup builder accepts tx mode with optional requestId', () => {
  const tx = '0x' + 'ab'.repeat(32)
  const prepared = buildStatusLookupParams({
    mode: 'tx',
    tx,
    requestId: '0x2A',
  })
  assert.equal(prepared.error, undefined)
  assert.equal(prepared.query, `tx=${tx}&requestId=42`)
})

test('status lookup builder rejects malformed tx hashes', () => {
  const prepared = buildStatusLookupParams({
    mode: 'tx',
    tx: '0x123',
  })
  assert.equal(prepared.error, 'INVALID_TX_HASH')
})

test('status lookup builder rejects all-zero tx hashes', () => {
  const prepared = buildStatusLookupParams({
    mode: 'tx',
    tx: '0x' + '0'.repeat(64),
  })
  assert.equal(prepared.error, 'INVALID_TX_HASH')
})

test('status lookup builder rejects invalid tx-mode request IDs', () => {
  const tx = '0x' + 'ab'.repeat(32)
  const prepared = buildStatusLookupParams({ mode: 'tx', tx, requestId: 'abc' })
  assert.equal(prepared.error, 'INVALID_REQUEST_ID')
})

test('status lookup builder accepts bounded requestId mode', () => {
  const prepared = buildStatusLookupParams({
    mode: 'requestId',
    requestId: '123',
    fromBlock: '10',
    toBlock: '12',
  })
  assert.equal(prepared.error, undefined)
  assert.equal(prepared.query, 'requestId=123&fromBlock=10&toBlock=12')
})

test('status lookup builder accepts requestId mode with uppercase hex requestId', () => {
  const prepared = buildStatusLookupParams({
    mode: 'requestId',
    requestId: '0X2A',
    fromBlock: '10',
  })
  assert.equal(prepared.error, undefined)
  assert.equal(prepared.query, 'requestId=42&fromBlock=10')
})

test('status lookup builder requires fromBlock in requestId mode', () => {
  const prepared = buildStatusLookupParams({
    mode: 'requestId',
    requestId: '123',
  })
  assert.equal(prepared.error, 'INVALID_FROM_BLOCK')
})

test('status lookup builder rejects invalid fromBlock and toBlock values', () => {
  const preparedFrom = buildStatusLookupParams({
    mode: 'requestId',
    requestId: '123',
    fromBlock: 'bad',
    toBlock: '100',
  })
  assert.equal(preparedFrom.error, 'INVALID_FROM_BLOCK')

  const preparedTo = buildStatusLookupParams({
    mode: 'requestId',
    requestId: '123',
    fromBlock: '10',
    toBlock: 'bad',
  })
  assert.equal(preparedTo.error, 'INVALID_TO_BLOCK')
})

test('status lookup builder rejects reversed blocks', () => {
  const prepared = buildStatusLookupParams({
    mode: 'requestId',
    requestId: '123',
    fromBlock: '20',
    toBlock: '10',
  })
  assert.equal(prepared.error, 'INVALID_BLOCK_RANGE')
})

test('status lookup builder trims whitespace from lookup values', () => {
  const prepared = buildStatusLookupParams({
    mode: 'requestId',
    requestId: '  0x2A  ',
    fromBlock: '  10  ',
    toBlock: '   ',
  })
  assert.equal(prepared.error, undefined)
  assert.equal(prepared.query, 'requestId=42&fromBlock=10')
})

test('request id parser rejects zero and accepts max bounds', () => {
  assert.equal(normalizeRequestIdLookup('0'), '')
  assert.equal(normalizeRequestIdLookup('0x0000000000000000000000000000000000000000000000000000000000000000'), '')
  assert.equal(normalizeRequestIdLookup('0x' + 'f'.repeat(64)), (1n << 256n) - 1n + '')
  assert.equal(normalizeRequestIdLookup('' + (1n << 256n)), '')
})

test('status lookup parser normalizes valid and invalid request ids', () => {
  assert.equal(normalizeTransactionLookupHash('0X' + 'ab'.repeat(32)), ('0x' + 'ab'.repeat(32)))
  assert.equal(normalizeTransactionLookupHash('bad-hash'), '')
  assert.equal(parseLookupBlock('123'), 123n)
  assert.equal(parseLookupBlock('  45  '), 45n)
  assert.equal(parseLookupBlock('-1'), null)
  assert.equal(parseLookupBlock(''), null)
})
