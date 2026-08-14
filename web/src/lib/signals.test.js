import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSignals, evaluateSnapshot, statusFromRatio } from './signals.js'

function snapshot(overrides = {}) {
  return {
    oracle: { timestamp: '1000', ageSeconds: 12 },
    queue: { totalLots: '80' },
    agents: {
      freeCollateralLots: '900',
      healthSummary: { total: 2, healthy: 2, warning: 0, critical: 0 },
    },
    protocol: {
      emergencyPaused: false,
      mintingPaused: false,
      currentUnderlyingBlock: { ageSeconds: 12 },
    },
    ...overrides,
  }
}

test('healthy live snapshot stays healthy', () => {
  const result = evaluateSignals(snapshot())

  assert.equal(result.overall.status, 'healthy')
  assert.equal(result.items.find((item) => item.id === 'queue').status, 'healthy')
  assert.equal(result.items.find((item) => item.id === 'oracle').status, 'healthy')
})

test('queue and pause conditions are surfaced without hiding healthy data', () => {
  const result = evaluateSignals(
    snapshot({
      queue: { totalLots: '1200' },
      protocol: {
        emergencyPaused: true,
        mintingPaused: false,
        currentUnderlyingBlock: { ageSeconds: 12 },
      },
    }),
  )

  assert.equal(result.overall.status, 'critical')
  assert.equal(result.items.find((item) => item.id === 'queue').status, 'critical')
  assert.equal(result.items.find((item) => item.id === 'protocol').status, 'critical')
})

test('ratio bands distinguish healthy, warning, and critical values', () => {
  assert.equal(statusFromRatio('16000', '15000', '16000'), 'healthy')
  assert.equal(statusFromRatio('15500', '15000', '16000'), 'warning')
  assert.equal(statusFromRatio('14999', '15000', '16000'), 'critical')
  assert.equal(statusFromRatio(null, '15000', '16000'), 'unknown')
})

test('incomplete collateral coverage is not reported as healthy', () => {
  const result = evaluateSignals(
    snapshot({
      agents: {
        freeCollateralLots: '900',
        healthSummary: { total: 2, healthy: 1, warning: 0, critical: 0, unknown: 1 },
      },
    }),
  )
  const collateral = result.items.find((item) => item.id === 'collateral')

  assert.equal(collateral.status, 'unknown')
  assert.match(collateral.value, /unavailable/)
})

test('custom queue warning threshold is preserved in exported snapshot', () => {
  const result = evaluateSnapshot(snapshot(), { queueWarningLots: 50 })
  const queue = result.signals.items.find((item) => item.id === 'queue')

  assert.equal(result.thresholds.queueWarningLots, 50)
  assert.equal(queue.status, 'warning')
})

test('queue critical threshold is normalized above warning threshold', () => {
  const result = evaluateSnapshot(snapshot({ queue: { totalLots: '80' } }), {
    queueWarningLots: 50,
    queueCriticalLots: 10,
  })

  assert.equal(result.thresholds.queueCriticalLots, 51)
})

test('oracle critical age is normalized above warning age', () => {
  const result = evaluateSnapshot(
    snapshot({ oracle: { timestamp: '1000', ageSeconds: '201' } }),
    {
      oracleWarningAgeSeconds: 200,
      oracleCriticalAgeSeconds: 50,
    },
  )
  const oracle = result.signals.items.find((item) => item.id === 'oracle')

  assert.equal(result.thresholds.oracleCriticalAgeSeconds, 201)
  assert.equal(oracle.status, 'warning')
})

test('underlying critical age is normalized above warning age', () => {
  const result = evaluateSnapshot(
    snapshot({
      oracle: { timestamp: '1000', ageSeconds: '12' },
      protocol: { emergencyPaused: false, mintingPaused: false, currentUnderlyingBlock: { ageSeconds: '201' } },
    }),
    {
      underlyingWarningAgeSeconds: 200,
      underlyingCriticalAgeSeconds: 50,
    },
  )
  const underlying = result.signals.items.find((item) => item.id === 'underlying')

  assert.equal(result.thresholds.underlyingCriticalAgeSeconds, 201)
  assert.equal(underlying.status, 'warning')
})
