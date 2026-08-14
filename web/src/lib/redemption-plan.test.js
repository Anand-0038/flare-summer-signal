import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRedemptionPlan,
  parseRedemptionPlanParams,
} from './redemption-plan.js'

const ASSET_MANAGER = '0x1111111111111111111111111111111111111111'
const FASSET = '0x2222222222222222222222222222222222222222'
const ACCOUNT = '0x3333333333333333333333333333333333333333'
const XRPL_ADDRESS = 'rSHYuiEvsYsKR8uUHhBTuGP5zjRcGt4nm'

function snapshot(overrides = {}) {
  return {
    network: { name: 'Coston2', chainId: 114, blockNumber: '1234' },
    source: { assetManager: ASSET_MANAGER, fAsset: FASSET },
    asset: {
      symbol: 'FTestXRP',
      lotSizeUBA: '10',
      minimumRedeemAmountUBA: '50',
    },
    ...overrides,
  }
}

test('transaction plan encodes redeemAmount without signing', () => {
  const plan = buildRedemptionPlan(snapshot(), {
    lots: '10',
    account: ACCOUNT,
    underlyingAddress: XRPL_ADDRESS,
    preview: { decision: 'ALLOW', outcome: 'FULL', reasonCodes: [] },
  })

  assert.equal(plan.decision, 'ALLOW')
  assert.equal(plan.status, 'NOT_SIMULATED')
  assert.equal(plan.transaction.functionName, 'redeemAmount')
  assert.deepEqual(plan.transaction.args, ['100', XRPL_ADDRESS, '0x0000000000000000000000000000000000000000'])
  assert.match(plan.transaction.data, /^0x[0-9a-f]+$/)
  assert.equal(plan.simulation.status, 'NOT_RUN')
  assert.equal(plan.reasonCodes.includes('SIMULATION_NOT_RUN'), false)
})

test('transaction plan stays WATCH until a wallet account is simulated', () => {
  const plan = buildRedemptionPlan(snapshot(), {
    lots: '10',
    underlyingAddress: XRPL_ADDRESS,
    preview: { decision: 'ALLOW', outcome: 'FULL', reasonCodes: [] },
  })

  assert.equal(plan.decision, 'WATCH')
  assert.equal(plan.status, 'NOT_SIMULATED')
  assert.ok(plan.reasonCodes.includes('SIMULATION_NOT_RUN'))
  assert.ok(plan.transaction)
})

test('transaction plan selects redeemWithTag and preserves the uint32 tag', () => {
  const plan = buildRedemptionPlan(snapshot(), {
    lots: '10',
    account: ACCOUNT,
    underlyingAddress: XRPL_ADDRESS,
    destinationTag: '4294967295',
    preview: { decision: 'ALLOW', outcome: 'FULL', reasonCodes: [] },
  })

  assert.equal(plan.transaction.functionName, 'redeemWithTag')
  assert.equal(plan.request.destinationTag, '4294967295')
  assert.equal(plan.transaction.args.at(-1), '4294967295')
})

test('transaction plan blocks amounts below the live minimum', () => {
  const plan = buildRedemptionPlan(snapshot(), {
    lots: '4',
    account: ACCOUNT,
    underlyingAddress: XRPL_ADDRESS,
    preview: { decision: 'ALLOW', outcome: 'FULL', reasonCodes: [] },
  })

  assert.equal(plan.decision, 'BLOCK')
  assert.equal(plan.transaction, null)
  assert.ok(plan.reasonCodes.includes('BELOW_MINIMUM_REDEEM'))
})

test('transaction plan blocks a partial FIFO preflight instead of encoding the full request', () => {
  const plan = buildRedemptionPlan(snapshot(), {
    lots: '10',
    account: ACCOUNT,
    underlyingAddress: XRPL_ADDRESS,
    preview: {
      decision: 'WATCH',
      outcome: 'PARTIAL',
      requestedLots: '10',
      result: { coveredLots: '5' },
      reasonCodes: ['MAX_TICKETS_REACHED'],
    },
  })

  assert.equal(plan.decision, 'BLOCK')
  assert.equal(plan.transaction, null)
  assert.ok(plan.reasonCodes.includes('PREFLIGHT_PARTIAL'))
})

test('transaction plan blocks when the registry-resolved Asset Manager is unavailable', () => {
  const plan = buildRedemptionPlan(
    snapshot({ source: { assetManager: null, fAsset: FASSET } }),
    {
      lots: '10',
      account: ACCOUNT,
      underlyingAddress: XRPL_ADDRESS,
      preview: { decision: 'ALLOW', outcome: 'FULL', reasonCodes: [] },
    },
  )

  assert.equal(plan.decision, 'BLOCK')
  assert.equal(plan.transaction, null)
  assert.ok(plan.reasonCodes.includes('ASSET_MANAGER_UNVERIFIED'))
})

test('plan query parsing requires an underlying address and bounds tags', () => {
  const valid = parseRedemptionPlanParams(new URLSearchParams(
    `lots=10&account=${ACCOUNT}&underlying=${XRPL_ADDRESS}&tag=72`,
  ))
  assert.equal(valid.lots, '10')
  assert.equal(valid.destinationTag, '72')
  assert.equal(valid.underlyingAddress, XRPL_ADDRESS)

  const missingUnderlying = parseRedemptionPlanParams(new URLSearchParams('lots=10'))
  assert.equal(missingUnderlying.error, 'INVALID_UNDERLYING_ADDRESS')

  const invalidUnderlying = parseRedemptionPlanParams(new URLSearchParams('lots=10&underlying=not-an-xrpl-address'))
  assert.equal(invalidUnderlying.error, 'INVALID_UNDERLYING_ADDRESS')

  const invalidChecksum = parseRedemptionPlanParams(new URLSearchParams(
    'lots=10&underlying=rSHYuiEvsYsKR8uUHhBTuGP5zjRcGt4nn',
  ))
  assert.equal(invalidChecksum.error, 'INVALID_UNDERLYING_ADDRESS')

  const oversizedTag = parseRedemptionPlanParams(new URLSearchParams(
    `lots=10&underlying=${XRPL_ADDRESS}&tag=4294967296`,
  ))
  assert.equal(oversizedTag.error, 'INVALID_DESTINATION_TAG')

  const whitespaceLots = parseRedemptionPlanParams(new URLSearchParams(
    `lots=%2010%20&account=${ACCOUNT}&underlying=${XRPL_ADDRESS}`,
  ))
  assert.equal(whitespaceLots.error, undefined)
  assert.equal(whitespaceLots.lots, '10')
  assert.equal(whitespaceLots.account, ACCOUNT)
})
