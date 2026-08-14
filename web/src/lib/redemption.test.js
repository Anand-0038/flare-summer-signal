import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRedemptionLots, previewRedemption } from './redemption.js'

const AGENT_ONE = '0x0000000000000000000000000000000000000001'
const AGENT_TWO = '0x0000000000000000000000000000000000000002'

function snapshot(overrides = {}) {
  return {
    network: { name: 'Coston2', chainId: 114, blockNumber: '1234' },
    source: { assetManager: '0xasset-manager', fAsset: '0xfasset' },
    asset: { symbol: 'FTestXRP', lotSizeUBA: '10' },
    settings: {
      maxRedeemedTickets: '2',
      underlyingBlocksForPayment: '500',
      underlyingSecondsForPayment: '900',
      redemptionFeeBIPS: '50',
    },
    oracle: { ageSeconds: 10 },
    queue: {
      totalLots: '80',
      ticketCount: 2,
      items: [
        { redemptionTicketId: '10', agentVault: AGENT_ONE, ticketValueUBA: '300' },
        { redemptionTicketId: '11', agentVault: AGENT_TWO, ticketValueUBA: '500' },
      ],
    },
    agents: {
      items: [
        {
          agentVault: AGENT_ONE,
          status: 'NORMAL',
          healthStatus: 'healthy',
          underlyingBalanceUBA: '1000',
          requiredUnderlyingBalanceUBA: '100',
          freeUnderlyingBalanceUBA: '900',
          redeemingUBA: '0',
        },
        {
          agentVault: AGENT_TWO,
          status: 'NORMAL',
          healthStatus: 'healthy',
          underlyingBalanceUBA: '1000',
          requiredUnderlyingBalanceUBA: '100',
          freeUnderlyingBalanceUBA: '900',
          redeemingUBA: '0',
        },
      ],
    },
    protocol: {
      emergencyPaused: false,
      mintingPaused: false,
      currentUnderlyingBlock: { ageSeconds: 10 },
    },
    signals: {
      items: [
        { id: 'queue', status: 'healthy', value: '80 lots', detail: 'queue is healthy' },
        { id: 'underlying', status: 'healthy', value: '10s', detail: 'sync is healthy' },
        { id: 'oracle', status: 'healthy', value: '10s', detail: 'oracle is healthy' },
      ],
    },
    thresholds: {},
    ...overrides,
  }
}

test('redemption preview consumes the live FIFO prefix and groups agent obligations', () => {
  const result = previewRedemption(snapshot(), '40')

  assert.equal(result.decision, 'ALLOW')
  assert.equal(result.outcome, 'FULL')
  assert.equal(result.result.coveredLots, '40')
  assert.equal(result.result.selectedTicketCount, 2)
  assert.deepEqual(
    result.result.selectedTickets.map((ticket) => [ticket.redemptionTicketId, ticket.selectedLots]),
    [['10', '30'], ['11', '10']],
  )
  assert.deepEqual(
    result.result.obligations.map((agent) => [agent.agentVault, agent.selectedLots]),
    [[AGENT_ONE, '30'], [AGENT_TWO, '10']],
  )
})

test('normalizeRedemptionLots accepts valid whole-lot counts and rejects malformed input', () => {
  assert.equal(normalizeRedemptionLots('40')?.toString(), '40')
  assert.equal(normalizeRedemptionLots('0'), null)
  assert.equal(normalizeRedemptionLots('1.5'), null)
  assert.equal(normalizeRedemptionLots('0x10'), null)
  assert.equal(normalizeRedemptionLots('1000000000000000001'), null)
})

test('redemption preview exposes a partial result when maxRedeemedTickets is reached', () => {
  const result = previewRedemption(
    snapshot({ settings: { maxRedeemedTickets: '1' } }),
    '40',
  )

  assert.equal(result.decision, 'WATCH')
  assert.equal(result.outcome, 'PARTIAL')
  assert.equal(result.result.coveredLots, '30')
  assert.equal(result.result.remainingLots, '10')
  assert.ok(result.reasonCodes.includes('MAX_TICKETS_REACHED'))
})

test('redemption preview blocks when the max redeemed tickets read is unverified', () => {
  const result = previewRedemption(
    snapshot({
      settings: {
        maxRedeemedTickets: '',
        underlyingBlocksForPayment: '500',
        underlyingSecondsForPayment: '900',
        redemptionFeeBIPS: '50',
      },
    }),
    '40',
  )

  assert.equal(result.decision, 'BLOCK')
  assert.equal(result.outcome, 'FULL')
  assert.equal(result.result.remainingLots, '0')
  assert.equal(result.certainty, 'unverified')
  assert.ok(result.reasonCodes.includes('MAX_TICKETS_UNVERIFIED'))
})

test('redemption preview blocks an unhealthy FIFO agent and never hides the reason', () => {
  const result = previewRedemption(
    snapshot({
      agents: {
        items: [
          {
            agentVault: AGENT_ONE,
            status: 'LIQUIDATION',
            healthStatus: 'critical',
            underlyingBalanceUBA: '1000',
            requiredUnderlyingBalanceUBA: '100',
            freeUnderlyingBalanceUBA: '900',
          },
        ],
      },
    }),
    '40',
  )

  assert.equal(result.decision, 'BLOCK')
  assert.ok(result.reasonCodes.includes('AGENT_NOT_NORMAL'))
  assert.ok(result.reasonCodes.includes('AGENT_STATE_UNVERIFIED'))
})

test('redemption preview fails closed when the emergency pause is active', () => {
  const result = previewRedemption(
    snapshot({ protocol: { emergencyPaused: true } }),
    '1',
  )

  assert.equal(result.decision, 'BLOCK')
  assert.ok(result.reasonCodes.includes('EMERGENCY_PAUSED'))
})

test('redemption preview checks free underlying balance for affected agents', () => {
  const result = previewRedemption(
    snapshot({
      agents: {
        items: [
          {
            agentVault: AGENT_ONE,
            status: 'NORMAL',
            healthStatus: 'healthy',
            underlyingBalanceUBA: '1000',
            requiredUnderlyingBalanceUBA: '980',
            freeUnderlyingBalanceUBA: '20',
          },
          {
            agentVault: AGENT_TWO,
            status: 'NORMAL',
            healthStatus: 'healthy',
            underlyingBalanceUBA: '1000',
            requiredUnderlyingBalanceUBA: '100',
            freeUnderlyingBalanceUBA: '900',
          },
        ],
      },
    }),
    '40',
  )

  assert.equal(result.decision, 'BLOCK')
  assert.ok(result.reasonCodes.includes('AGENT_UNDERLYING_COVER'))
})

test('redemption preview blocks when a FIFO agent is absent from the pinned agent read', () => {
  const result = previewRedemption(snapshot({ agents: { items: [] } }), '1')

  assert.equal(result.decision, 'BLOCK')
  assert.ok(result.reasonCodes.includes('AGENT_STATE_UNVERIFIED'))
})

test('redemption preview uses pinned queue-agent evidence even when the agent is not public', () => {
  const queueAgent = {
    ...snapshot().agents.items[0],
    publiclyAvailable: false,
  }
  const result = previewRedemption(
    snapshot({
      agents: { items: [] },
      redemptionAgents: { totalObserved: 1, items: [queueAgent] },
    }),
    '1',
  )

  assert.equal(result.decision, 'ALLOW')
  assert.equal(result.result.obligations[0].agentVault, AGENT_ONE)
})

test('redemption preview blocks when an affected agent has no free underlying balance evidence', () => {
  const agentWithoutFreeBalance = {
    ...snapshot().agents.items[0],
    freeUnderlyingBalanceUBA: null,
  }
  const result = previewRedemption(
    snapshot({ agents: { items: [agentWithoutFreeBalance] } }),
    '1',
  )

  assert.equal(result.decision, 'BLOCK')
  assert.ok(result.reasonCodes.includes('AGENT_FREE_UNDERLYING_UNVERIFIED'))
})
