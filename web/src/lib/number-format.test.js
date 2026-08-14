import test from 'node:test'
import assert from 'node:assert/strict'

import { formatInteger } from './number-format.js'

test('formatInteger preserves large integer-like strings without precision loss', () => {
  assert.equal(formatInteger('9007199254740993'), '9,007,199,254,740,993')
  assert.equal(formatInteger('100000000000000000000'), '100,000,000,000,000,000,000')
})

test('formatInteger handles non-integer and invalid values like Number formatter did', () => {
  assert.equal(formatInteger('42.5'), '42.5')
  assert.equal(formatInteger('  100 '), '100')
  assert.equal(formatInteger(undefined), '—')
  assert.equal(formatInteger(null), '—')
  assert.equal(formatInteger('bad'), '—')
})
