import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateOperation } from './guardian.js'
import { evaluateSnapshot } from './signals.js'

function liveSnapshot(overrides = {}) {
  return {
    network: { name: 'Coston2', chainId: 114, blockNumber: '1234' },
    source: { assetManager: '0xasset-manager', fAsset: '0xfasset' },
    asset: { symbol: 'FXRP' },
    oracle: { timestamp: '1000', ageSeconds: 12 },
    queue: { totalLots: '80' },
    agents: {
      totalAvailable: 2,
      freeCollateralLots: '900',
      healthSummary: { total: 2, healthy: 2, warning: 0, critical: 0, unknown: 0 },
      items: [
        {
          agentVault: '0xagent-two',
          status: 'NORMAL',
          healthStatus: 'healthy',
          feeBIPS: '25',
          freeCollateralLots: '700',
        },
        {
          agentVault: '0xagent-one',
          status: 'NORMAL',
          healthStatus: 'healthy',
          feeBIPS: '10',
          freeCollateralLots: '200',
        },
      ],
    },
    protocol: {
      emergencyPaused: false,
      mintingPaused: false,
      currentUnderlyingBlock: { ageSeconds: 12 },
    },
    ...overrides,
  }
}

function evaluated(overrides = {}, thresholds = {}) {
  return evaluateSnapshot(liveSnapshot(overrides), thresholds)
}

test('Guardian allows a mint and selects the lowest-fee healthy route', () => {
  const snapshot = evaluated()
  const decision = snapshot.guardian.decisions.find((item) => item.operation === 'mint_fxrp')
  const requested = evaluateOperation(snapshot, snapshot.thresholds, 'mint_fxrp', '100')

  assert.equal(decision.decision, 'ALLOW')
  assert.equal(requested.decision, 'ALLOW')
  assert.equal(requested.route.agentVault, '0xagent-one')
  assert.equal(requested.route.feeBIPS, '10')
  assert.equal(requested.evidence.blockNumber, '1234')
})

test('Guardian blocks a mint when no healthy agent covers the requested size', () => {
  const snapshot = evaluated({
    agents: {
      totalAvailable: 1,
      freeCollateralLots: '900',
      healthSummary: { total: 1, healthy: 0, warning: 0, critical: 1, unknown: 0 },
      items: [
        {
          agentVault: '0xagent-one',
          status: 'LIQUIDATION',
          healthStatus: 'critical',
          feeBIPS: '10',
          freeCollateralLots: '900',
        },
      ],
    },
  })
  const decision = evaluateOperation(snapshot, snapshot.thresholds, 'mint_fxrp', '100')

  assert.equal(decision.decision, 'BLOCK')
  assert.ok(decision.reasonCodes.includes('COLLATERAL_CRITICAL'))
  assert.ok(decision.reasonCodes.includes('NO_HEALTHY_ROUTE'))
})

test('Guardian fails closed when underlying synchronization is unavailable', () => {
  const snapshot = evaluated({
    protocol: {
      emergencyPaused: false,
      mintingPaused: false,
      currentUnderlyingBlock: { ageSeconds: null },
    },
  })
  const decision = evaluateOperation(snapshot, snapshot.thresholds, 'accept_fxrp', '1')

  assert.equal(decision.decision, 'BLOCK')
  assert.equal(decision.certainty, 'unverified')
  assert.ok(decision.reasonCodes.includes('UNDERLYING_UNVERIFIED'))
})

test('Guardian marks elevated queue pressure as WATCH and critical pressure as BLOCK', () => {
  const warning = evaluated({ queue: { totalLots: '500' } })
  const critical = evaluated({ queue: { totalLots: '1000' } })

  assert.equal(
    evaluateOperation(warning, warning.thresholds, 'redeem_fxrp', '1').decision,
    'WATCH',
  )
  assert.equal(
    evaluateOperation(critical, critical.thresholds, 'redeem_fxrp', '1').decision,
    'BLOCK',
  )
})

test('Guardian gives lending a stricter collateral policy than acceptance', () => {
  const snapshot = evaluated({
    agents: {
      totalAvailable: 2,
      freeCollateralLots: '900',
      healthSummary: { total: 2, healthy: 1, warning: 1, critical: 0, unknown: 0 },
      items: liveSnapshot().agents.items,
    },
  })
  const lending = evaluateOperation(snapshot, snapshot.thresholds, 'lend_against_fxrp', '100')
  const acceptance = evaluateOperation(snapshot, snapshot.thresholds, 'accept_fxrp', '100')

  assert.equal(lending.decision, 'BLOCK')
  assert.ok(lending.reasonCodes.includes('LENDING_COLLATERAL_WATCH'))
  assert.equal(acceptance.decision, 'WATCH')
})

test('Guardian does not block existing FXRP acceptance just because minting is paused', () => {
  const snapshot = evaluated({
    protocol: {
      emergencyPaused: false,
      mintingPaused: true,
      currentUnderlyingBlock: { ageSeconds: 12 },
    },
  })
  const mint = evaluateOperation(snapshot, snapshot.thresholds, 'mint_fxrp', '100')
  const acceptance = evaluateOperation(snapshot, snapshot.thresholds, 'accept_fxrp', '100')

  assert.equal(mint.decision, 'BLOCK')
  assert.ok(mint.reasonCodes.includes('MINTING_PAUSED'))
  assert.equal(acceptance.decision, 'ALLOW')
})

test('Guardian policy normalization keeps critical freshness age above warning', () => {
  const snapshot = evaluated(
    {
      oracle: { timestamp: '1000', ageSeconds: '201' },
      protocol: {
        emergencyPaused: false,
        mintingPaused: false,
        currentUnderlyingBlock: { ageSeconds: '12' },
      },
    },
    {
      oracleWarningAgeSeconds: 200,
      oracleCriticalAgeSeconds: 50,
    },
  )
  const acceptance = evaluateOperation(snapshot, snapshot.thresholds, 'accept_fxrp', '1')

  assert.equal(snapshot.thresholds.oracleCriticalAgeSeconds, 201)
  assert.equal(acceptance.decision, 'WATCH')
  assert.ok(acceptance.reasonCodes.includes('ORACLE_WATCH'))
})

test('Guardian policy normalization keeps queue critical lots above warning lots', () => {
  const snapshot = evaluated(
    {
      queue: { totalLots: '6' },
      oracle: { timestamp: '1000', ageSeconds: '12' },
      protocol: {
        emergencyPaused: false,
        mintingPaused: false,
        currentUnderlyingBlock: { ageSeconds: '12' },
      },
    },
    {
      queueWarningLots: 5,
      queueCriticalLots: 3,
    },
  )
  const decision = evaluateOperation(snapshot, snapshot.thresholds, 'accept_fxrp', '1')

  assert.equal(snapshot.thresholds.queueCriticalLots, 6)
  assert.equal(decision.decision, 'BLOCK')
  assert.ok(decision.reasonCodes.includes('QUEUE_CRITICAL'))
})
