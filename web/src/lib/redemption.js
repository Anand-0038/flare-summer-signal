export const DEFAULT_REDEMPTION_LOTS = '100'

export function previewRedemption(snapshot, requestedLots = DEFAULT_REDEMPTION_LOTS) {
  const lots = normalizeRedemptionLots(requestedLots)
  if (lots === null) {
    return invalidPreview(requestedLots, 'Enter a positive whole number of FXRP lots.')
  }

  const lotSizeUBA = toBigInt(snapshot?.asset?.lotSizeUBA)
  const maxRedeemedTickets = toBigInt(snapshot?.settings?.maxRedeemedTickets)
  const queueItems = snapshot?.queue?.items
  const reasons = []

  if (lotSizeUBA === null || lotSizeUBA <= 0n || !Array.isArray(queueItems)) {
    return invalidPreview(
      lots.toString(),
      'The live queue or lot-size read is incomplete. The redemption path is blocked until it can be verified.',
      ['QUEUE_UNVERIFIED'],
    )
  }

  if (maxRedeemedTickets === null || maxRedeemedTickets <= 0n) {
    addReason(
      reasons,
      'MAX_TICKETS_UNVERIFIED',
      'critical',
      'Redemption ticket cap is unverified',
      'Guardian cannot know whether this request will be truncated without the live maxRedeemedTickets setting.',
    )
  }

  if (snapshot?.protocol?.emergencyPaused === true) {
    addReason(
      reasons,
      'EMERGENCY_PAUSED',
      'critical',
      'FAssets emergency pause is active',
      'The Asset Manager will reject redemption while the emergency pause is active.',
    )
  } else if (typeof snapshot?.protocol?.emergencyPaused !== 'boolean') {
    addReason(
      reasons,
      'PROTOCOL_UNVERIFIED',
      'critical',
      'Protocol pause state is unverified',
      'Guardian did not receive a complete Asset Manager pause read.',
    )
  }

  applySignalPolicy(reasons, snapshot?.signals, 'queue', 'redemption queue')
  applySignalPolicy(reasons, snapshot?.signals, 'underlying', 'underlying synchronization')
  applySignalPolicy(reasons, snapshot?.signals, 'oracle', 'XRP/USD oracle freshness')

  const selectedTickets = []
  const obligationMap = new Map()
  let remainingLots = lots

  for (let index = 0; index < queueItems.length && remainingLots > 0n; index += 1) {
    if (maxRedeemedTickets !== null && selectedTickets.length >= maxRedeemedTickets) break

    const ticket = queueItems[index]
    const ticketValueUBA = toBigInt(ticket?.ticketValueUBA)
    if (ticketValueUBA === null || ticketValueUBA <= 0n) {
      addReason(
        reasons,
        'QUEUE_TICKET_UNVERIFIED',
        'critical',
        'A FIFO ticket has an invalid value',
        `Ticket ${ticket?.redemptionTicketId || 'unknown'} could not be converted into lots.`,
      )
      break
    }

    const ticketLots = ticketValueUBA / lotSizeUBA
    if (ticketLots <= 0n) {
      addReason(
        reasons,
        'QUEUE_TICKET_DUST',
        'critical',
        'A FIFO ticket has no redeemable whole lots',
        `Ticket ${ticket.redemptionTicketId || 'unknown'} is smaller than the live lot size.`,
      )
      break
    }

    const selectedLots = minBigInt(remainingLots, ticketLots)
    const selectedValueUBA = selectedLots * lotSizeUBA
    const remainingTicketLots = ticketLots - selectedLots
    const selected = {
      position: selectedTickets.length + 1,
      redemptionTicketId: String(ticket.redemptionTicketId || ''),
      agentVault: String(ticket.agentVault || ''),
      ticketLots: ticketLots.toString(),
      selectedLots: selectedLots.toString(),
      selectedValueUBA: selectedValueUBA.toString(),
      remainingTicketLots: remainingTicketLots.toString(),
    }
    selectedTickets.push(selected)
    remainingLots -= selectedLots

    const key = selected.agentVault.toLowerCase()
    const existing = obligationMap.get(key) || {
      agentVault: selected.agentVault,
      selectedLots: 0n,
      selectedValueUBA: 0n,
      ticketCount: 0,
    }
    existing.selectedLots += selectedLots
    existing.selectedValueUBA += selectedValueUBA
    existing.ticketCount += 1
    obligationMap.set(key, existing)
  }

  const coveredLots = lots - remainingLots
  if (coveredLots === 0n) {
    addReason(
      reasons,
      'QUEUE_EMPTY',
      'critical',
      'No FIFO ticket can cover this redemption',
      'The live redemption queue did not expose a redeemable ticket for the requested amount.',
    )
  } else if (remainingLots > 0n) {
    const capReached = maxRedeemedTickets !== null && BigInt(selectedTickets.length) >= maxRedeemedTickets
    addReason(
      reasons,
      capReached ? 'MAX_TICKETS_REACHED' : 'QUEUE_SHORTFALL',
      'warning',
      capReached ? 'The protocol ticket cap makes this redemption partial' : 'The live queue cannot cover the full request',
      capReached
        ? `The preview reaches ${maxRedeemedTickets.toString()} tickets before covering the requested ${lots.toString()} lots.`
        : `The preview covers ${coveredLots.toString()} of ${lots.toString()} requested lots from the current queue.`,
    )
  }

  const obligations = [...obligationMap.values()].map((obligation) =>
    evaluateAgentObligation(snapshot, obligation, reasons),
  )

  const decision = reasons.some((reason) => reason.severity === 'critical')
    ? 'BLOCK'
    : reasons.some((reason) => reason.severity === 'warning')
      ? 'WATCH'
      : 'ALLOW'
  const outcome = coveredLots === 0n ? 'NONE' : remainingLots > 0n ? 'PARTIAL' : 'FULL'
  const certainty = reasons.some((reason) => reason.code.includes('UNVERIFIED'))
    ? 'unverified'
    : 'observed'

  return {
    schemaVersion: 1,
    operation: 'redeem_fxrp',
    operationLabel: 'Redeem FXRP',
    operationDescription: 'Preview the FIFO tickets and agent obligations selected by an FXRP redemption.',
    requestedLots: lots.toString(),
    assetSymbol: snapshot?.asset?.symbol || 'FXRP',
    decision,
    status: statusForDecision(decision),
    certainty,
    outcome,
    headline: headlineFor(decision, outcome),
    summary: summaryFor(decision, outcome, lots, coveredLots, selectedTickets.length, obligations.length),
    reasonCodes: reasons.map((reason) => reason.code),
    reasons,
    result: {
      requestedLots: lots.toString(),
      coveredLots: coveredLots.toString(),
      remainingLots: remainingLots.toString(),
      requestedValueUBA: (lots * lotSizeUBA).toString(),
      coveredValueUBA: (coveredLots * lotSizeUBA).toString(),
      selectedTicketCount: selectedTickets.length,
      maxRedeemedTickets: maxRedeemedTickets?.toString() || null,
      selectedTickets,
      obligations,
    },
    evidence: evidenceFor(snapshot, maxRedeemedTickets, selectedTickets.length),
    policy: snapshot?.thresholds || null,
  }
}

export function normalizeRedemptionLots(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  if (!/^[1-9]\d*$/.test(text)) return null

  try {
    const lots = BigInt(text)
    return lots > 0n && lots <= 1_000_000_000_000_000_000n ? lots : null
  } catch {
    return null
  }
}

function evaluateAgentObligation(snapshot, obligation, reasons) {
  const observedAgents = snapshot?.redemptionAgents?.items || snapshot?.agents?.items
  const agent = observedAgents?.find(
    (item) => item.agentVault?.toLowerCase() === obligation.agentVault.toLowerCase(),
  )
  const selectedLots = toBigInt(obligation.selectedLots)
  const selectedValueUBA = toBigInt(obligation.selectedValueUBA)
  const underlyingBalanceUBA = toBigInt(agent?.underlyingBalanceUBA)
  const freeUnderlyingBalanceUBA = toBigInt(agent?.freeUnderlyingBalanceUBA)
  let status = agent?.healthStatus || 'unknown'

  if (
    selectedLots === null
    || selectedValueUBA === null
    || selectedValueUBA <= 0n
    || selectedLots <= 0n
  ) {
    addReason(
      reasons,
      'AGENT_OBLIGATION_UNVERIFIED',
      'critical',
      'An inherited redemption obligation could not be verified',
      `${shortAddress(obligation.agentVault)} has malformed obligation math, so the preview cannot be trusted.`,
    )
  }

  if (!agent) {
    addReason(
      reasons,
      'AGENT_STATE_UNVERIFIED',
      'critical',
      'A queued agent is not in the live agent read',
      `${shortAddress(obligation.agentVault)} cannot be checked before inheriting its redemption obligation.`,
    )
  } else if (agent.status !== 'NORMAL') {
    status = 'critical'
    addReason(
      reasons,
      'AGENT_NOT_NORMAL',
      'critical',
      'A FIFO agent is not NORMAL',
      `${shortAddress(obligation.agentVault)} is ${agent.status}; the request should be blocked.`,
    )
  } else if (!agent.healthStatus || agent.healthStatus === 'unknown') {
    addReason(
      reasons,
      'AGENT_HEALTH_UNVERIFIED',
      'critical',
      'A FIFO agent has incomplete collateral evidence',
      `${shortAddress(obligation.agentVault)} does not have a complete collateral comparison.`,
    )
  } else if (agent.healthStatus === 'critical') {
    addReason(
      reasons,
      'AGENT_COLLATERAL_CRITICAL',
      'critical',
      'A FIFO agent is below collateral policy',
      `${shortAddress(obligation.agentVault)} is outside the live minimum collateral band.`,
    )
  } else if (agent.healthStatus === 'warning') {
    addReason(
      reasons,
      'AGENT_COLLATERAL_WATCH',
      'warning',
      'A FIFO agent is in the collateral watch band',
      `${shortAddress(obligation.agentVault)} is healthy enough to observe but needs review.`,
    )
  }

  if (freeUnderlyingBalanceUBA === null) {
    addReason(
      reasons,
      'AGENT_FREE_UNDERLYING_UNVERIFIED',
      'critical',
      'An agent free underlying balance is unverified',
      `${shortAddress(obligation.agentVault)} has no usable free underlying balance read for this obligation.`,
    )
  } else if (
    selectedValueUBA !== null
    && freeUnderlyingBalanceUBA !== null
    && freeUnderlyingBalanceUBA < selectedValueUBA
  ) {
    status = 'critical'
    addReason(
      reasons,
      'AGENT_UNDERLYING_COVER',
      'critical',
      'An agent free balance is below the observed payout amount',
      `${shortAddress(obligation.agentVault)} shows ${freeUnderlyingBalanceUBA.toString()} free UBA against ${selectedValueUBA.toString()} UBA selected.`,
    )
  }

  return {
    agentVault: obligation.agentVault,
    selectedLots: selectedLots?.toString() || null,
    selectedValueUBA: selectedValueUBA?.toString() || null,
    ticketCount: obligation.ticketCount,
    status,
    agentStatus: agent?.status || 'UNVERIFIED',
    healthStatus: agent?.healthStatus || 'unknown',
    underlyingBalanceUBA: underlyingBalanceUBA?.toString() || null,
    requiredUnderlyingBalanceUBA: toBigInt(agent?.requiredUnderlyingBalanceUBA)?.toString() || null,
    freeUnderlyingBalanceUBA: freeUnderlyingBalanceUBA?.toString() || null,
    redeemingUBA: toBigInt(agent?.redeemingUBA)?.toString() || null,
  }
}

function applySignalPolicy(reasons, signals, signalId, label) {
  const signal = signals?.items?.find((item) => item.id === signalId)
  if (!signal || signal.status === 'unknown') {
    addReason(
      reasons,
      `${signalId.toUpperCase()}_UNVERIFIED`,
      'critical',
      `${label} is unverified`,
      signal?.detail || `Guardian did not receive a usable ${label} read.`,
    )
    return
  }
  if (signal.status === 'critical') {
    addReason(
      reasons,
      `${signalId.toUpperCase()}_CRITICAL`,
      'critical',
      `${label} is outside policy`,
      `${signal.value}. ${signal.detail}`,
    )
  } else if (signal.status === 'warning') {
    addReason(
      reasons,
      `${signalId.toUpperCase()}_WATCH`,
      'warning',
      `${label} needs review`,
      `${signal.value}. ${signal.detail}`,
    )
  }
}

function evidenceFor(snapshot, maxRedeemedTickets, selectedTicketCount) {
  return {
    network: snapshot?.network?.name || null,
    chainId: snapshot?.network?.chainId ?? null,
    blockNumber: snapshot?.network?.blockNumber || null,
    generatedAt: snapshot?.generatedAt || null,
    assetManager: snapshot?.source?.assetManager || null,
    fAsset: snapshot?.source?.fAsset || null,
    queueLots: snapshot?.queue?.totalLots || null,
    queueTickets: snapshot?.queue?.ticketCount ?? null,
    selectedTicketCount,
    maxRedeemedTickets: maxRedeemedTickets?.toString() || null,
    oracleAgeSeconds: snapshot?.oracle?.ageSeconds ?? null,
    underlyingAgeSeconds: snapshot?.protocol?.currentUnderlyingBlock?.ageSeconds ?? null,
    paymentWindow: {
      seconds: snapshot?.settings?.underlyingSecondsForPayment || null,
      blocks: snapshot?.settings?.underlyingBlocksForPayment || null,
    },
    redemptionFeeBIPS: snapshot?.settings?.redemptionFeeBIPS || null,
  }
}

function invalidPreview(requestedLots, summary, reasonCodes = ['INVALID_LOTS']) {
  return {
    schemaVersion: 1,
    operation: 'redeem_fxrp',
    operationLabel: 'Redeem FXRP',
    requestedLots: String(requestedLots ?? ''),
    assetSymbol: 'FXRP',
    decision: 'BLOCK',
    status: 'critical',
    certainty: 'unverified',
    outcome: 'NONE',
    headline: 'A verified redemption path is required.',
    summary,
    reasonCodes,
    reasons: [{
      code: reasonCodes[0],
      severity: 'critical',
      title: reasonCodes[0] === 'INVALID_LOTS' ? 'Invalid redemption request' : 'Live redemption evidence is incomplete',
      detail: summary,
    }],
    result: {
      requestedLots: String(requestedLots ?? ''),
      coveredLots: '0',
      remainingLots: String(requestedLots ?? ''),
      requestedValueUBA: null,
      coveredValueUBA: '0',
      selectedTicketCount: 0,
      maxRedeemedTickets: null,
      selectedTickets: [],
      obligations: [],
    },
    evidence: null,
    policy: null,
  }
}

function addReason(reasons, code, severity, title, detail) {
  if (reasons.some((reason) => reason.code === code)) return
  reasons.push({ code, severity, title, detail })
}

function statusForDecision(decision) {
  return decision === 'ALLOW' ? 'healthy' : decision === 'WATCH' ? 'warning' : 'critical'
}

function headlineFor(decision, outcome) {
  if (decision === 'ALLOW') return 'The FIFO path is fully covered.'
  if (decision === 'WATCH' && outcome === 'PARTIAL') return 'The protocol will only cover part of this request.'
  if (decision === 'WATCH') return 'The path exists, but an operator check is required.'
  return 'Do not submit this redemption yet.'
}

function summaryFor(decision, outcome, requestedLots, coveredLots, ticketCount, obligationCount) {
  if (decision === 'ALLOW') {
    return `${coveredLots.toString()} lots resolve across ${ticketCount} FIFO ticket${ticketCount === 1 ? '' : 's'} and ${obligationCount} agent${obligationCount === 1 ? '' : 's'} with no blocking signal.`
  }
  if (decision === 'WATCH' && outcome === 'PARTIAL') {
    return `${coveredLots.toString()} of ${requestedLots.toString()} requested lots are covered by the current FIFO prefix. The caller must handle the remainder explicitly.`
  }
  if (decision === 'WATCH') {
    return `The current FIFO prefix covers ${coveredLots.toString()} lots across ${obligationCount} agent${obligationCount === 1 ? '' : 's'}, but the live evidence needs review before signing.`
  }
  return 'One or more live protocol, queue, agent, or evidence checks block a safe redemption preflight.'
}

function minBigInt(left, right) {
  return left < right ? left : right
}

function toBigInt(value) {
  if (value === null || value === undefined || value === '') return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function shortAddress(value) {
  if (!value || value.length < 12) return value || 'unknown agent'
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}
