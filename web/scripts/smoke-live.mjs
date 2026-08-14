import assert from 'node:assert/strict'
import { fetchFassetSnapshot } from '../src/lib/fassets.js'
import { previewRedemption } from '../src/lib/redemption.js'

const snapshot = await fetchFassetSnapshot()

assert.equal(snapshot.network.chainId, 114)
assert.equal(snapshot.network.name, 'Coston2')
assert.equal('rpcUrl' in snapshot.network, false)
assert.match(snapshot.source.assetManager, /^0x[0-9a-fA-F]{40}$/)
assert.match(snapshot.source.fAsset, /^0x[0-9a-fA-F]{40}$/)
assert.match(snapshot.oracle.feed, /^XRP\/USD$/)
assert.ok(Number(snapshot.network.blockNumber) > 0)
assert.ok(Number(snapshot.oracle.timestamp) > 0)
assert.ok(Array.isArray(snapshot.queue.items))
assert.ok(Array.isArray(snapshot.agents.items))
assert.ok(Array.isArray(snapshot.collateralTypes))
assert.match(snapshot.settings.maxRedeemedTickets, /^\d+$/)
assert.match(snapshot.asset.minimumRedeemAmountUBA, /^\d+$/)
const redemptionPreview = previewRedemption(snapshot, '100')
assert.equal(redemptionPreview.operation, 'redeem_fxrp')
assert.match(redemptionPreview.decision, /^(ALLOW|WATCH|BLOCK)$/)
assert.equal(redemptionPreview.evidence.blockNumber, snapshot.network.blockNumber)

console.log(
  JSON.stringify(
    {
      ok: true,
      chainId: snapshot.network.chainId,
      blockNumber: snapshot.network.blockNumber,
      assetManager: snapshot.source.assetManager,
      fAsset: snapshot.source.fAsset,
      oracle: snapshot.oracle.price,
      oracleAgeSeconds: snapshot.oracle.ageSeconds,
      queueLots: snapshot.queue.totalLots,
      availableAgents: snapshot.agents.totalAvailable,
      overall: snapshot.signals.overall.status,
      redemption: redemptionPreview.decision,
      redemptionOutcome: redemptionPreview.outcome,
      redemptionReasonCodes: redemptionPreview.reasonCodes,
      selectedTickets: redemptionPreview.result.selectedTicketCount,
      maxRedeemedTickets: snapshot.settings.maxRedeemedTickets,
      minimumRedeemAmountUBA: snapshot.asset.minimumRedeemAmountUBA,
      affectedAgents: redemptionPreview.result.obligations.length,
    },
    null,
    2,
  ),
)
