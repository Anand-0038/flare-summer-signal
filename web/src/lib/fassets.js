import { createPublicClient, formatUnits, http, parseAbi } from 'viem'
import { DEFAULT_THRESHOLDS, evaluateSnapshot, statusFromRatio } from './signals.js'

export const DEFAULT_RPC_URL = 'https://coston2-api.flare.network/ext/C/rpc'
export const COSTON2_CHAIN_ID = 114
export const FLARE_CONTRACT_REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019'
export const XRP_USD_FEED_ID = '0x015852502f55534400000000000000000000000000'
export const COSTON2_EXPLORER = 'https://coston2-explorer.flare.network'

const MAX_AGENTS = 500
const AGENT_PAGE_SIZE = 50
const MAX_QUEUE_TICKETS = 5_000
const QUEUE_PAGE_SIZE = 100
const RPC_TIMEOUT_MS = 15_000
const RPC_RETRY_COUNT = 2
const RPC_RETRY_DELAY_MS = 500
const RPC_BATCH_WAIT_MS = 10
const RPC_BATCH_SIZE = 50

export function resolveRpcUrl() {
  const primary = String(process.env.FLARE_RPC_URL || '').trim()
  const legacy = String(process.env.COSTON2_RPC_URL || '').trim()
  return primary || legacy || undefined
}

const REGISTRY_ABI = parseAbi([
  'function getContractAddressByName(string _name) view returns (address)',
])

const FTSO_ABI = parseAbi([
  'function getFeedById(bytes21 _feedId) payable returns (uint256 value, int8 decimals, uint64 timestamp)',
])

export const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
])

export const ASSET_MANAGER_ABI = parseAbi([
  'function fAsset() view returns (address)',
  'function lotSize() view returns (uint256)',
  'function minimumRedeemAmountUBA() view returns (uint256)',
  'function redeemAmount(uint256 _amountUBA,string _redeemerUnderlyingAddressString,address payable _executor) payable returns (uint256 _redeemedAmountUBA)',
  'function redeemWithTag(uint256 _amountUBA,string _redeemerUnderlyingAddressString,address payable _executor,uint256 _destinationTag) payable returns (uint256 _redeemedAmountUBA)',
  'function getSettings() view returns ((address assetManagerController,address fAsset,address agentVaultFactory,address collateralPoolFactory,address collateralPoolTokenFactory,string poolTokenSuffix,address __whitelist,address agentOwnerRegistry,address fdcVerification,address burnAddress,address priceReader,uint8 assetDecimals,uint8 assetMintingDecimals,bytes32 chainId,uint32 averageBlockTimeMS,uint32 mintingPoolHoldingsRequiredBIPS,uint16 collateralReservationFeeBIPS,uint64 assetUnitUBA,uint64 assetMintingGranularityUBA,uint64 lotSizeAMG,uint16 __minUnderlyingBackingBIPS,bool __requireEOAAddressProof,uint64 mintingCapAMG,uint64 underlyingBlocksForPayment,uint64 underlyingSecondsForPayment,uint16 redemptionFeeBIPS,uint32 redemptionDefaultFactorVaultCollateralBIPS,uint32 __redemptionDefaultFactorPoolBIPS,uint64 confirmationByOthersAfterSeconds,uint128 confirmationByOthersRewardUSD5,uint16 maxRedeemedTickets,uint16 paymentChallengeRewardBIPS,uint128 paymentChallengeRewardUSD5,uint64 withdrawalWaitMinSeconds,uint64 maxTrustedPriceAgeSeconds,uint64 __ccbTimeSeconds,uint64 attestationWindowSeconds,uint64 minUpdateRepeatTimeSeconds,uint64 __buybackCollateralFactorBIPS,uint64 __announcedUnderlyingConfirmationMinSeconds,uint64 __tokenInvalidationTimeMinSeconds,uint32 vaultCollateralBuyForFlareFactorBIPS,uint64 agentExitAvailableTimelockSeconds,uint64 agentFeeChangeTimelockSeconds,uint64 agentMintingCRChangeTimelockSeconds,uint64 poolExitCRChangeTimelockSeconds,uint64 agentTimelockedOperationWindowSeconds,uint32 collateralPoolTokenTimelockSeconds,uint64 liquidationStepSeconds,uint256[] liquidationCollateralFactorBIPS,uint256[] liquidationFactorVaultCollateralBIPS,uint64 diamondCutMinTimelockSeconds,uint64 maxEmergencyPauseDurationSeconds,uint64 emergencyPauseDurationResetAfterSeconds,uint64 __cancelCollateralReservationAfterSeconds,uint16 __rejectOrCancelCollateralReservationReturnFactorBIPS,uint64 __rejectRedemptionRequestWindowSeconds,uint64 __takeOverRedemptionRequestWindowSeconds,uint32 __rejectedRedemptionDefaultFactorVaultCollateralBIPS,uint32 __rejectedRedemptionDefaultFactorPoolBIPS))',
  'function assetMintingGranularityUBA() view returns (uint256)',
  'function assetMintingDecimals() view returns (uint256)',
  'function emergencyPaused() view returns (bool)',
  'function emergencyPauseLevel() view returns (uint8)',
  'function mintingPaused() view returns (bool)',
  'function currentUnderlyingBlock() view returns (uint256 blockNumber, uint256 blockTimestamp, uint256 lastUpdateTs)',
  'function getCollateralTypes() view returns ((uint8 collateralClass, address token, uint256 decimals, uint256 validUntil, bool directPricePair, string assetFtsoSymbol, string tokenFtsoSymbol, uint256 minCollateralRatioBIPS, uint256 safetyMinCollateralRatioBIPS)[])',
  'function getAvailableAgentsDetailedList(uint256 _start, uint256 _end) view returns ((address agentVault, address ownerManagementAddress, uint256 feeBIPS, uint256 mintingVaultCollateralRatioBIPS, uint256 mintingPoolCollateralRatioBIPS, uint256 freeCollateralLots, uint8 status)[] _agents, uint256 _totalLength)',
  'function getAgentInfo(address _agentVault) view returns ((uint8 status, address ownerManagementAddress, address ownerWorkAddress, address collateralPool, address collateralPoolToken, string underlyingAddressString, bool publiclyAvailable, uint256 feeBIPS, uint256 poolFeeShareBIPS, address vaultCollateralToken, uint256 mintingVaultCollateralRatioBIPS, uint256 mintingPoolCollateralRatioBIPS, uint256 freeCollateralLots, uint256 totalVaultCollateralWei, uint256 freeVaultCollateralWei, uint256 vaultCollateralRatioBIPS, address poolWNatToken, uint256 totalPoolCollateralNATWei, uint256 freePoolCollateralNATWei, uint256 poolCollateralRatioBIPS, uint256 totalAgentPoolTokensWei, uint256 announcedVaultCollateralWithdrawalWei, uint256 announcedPoolTokensWithdrawalWei, uint256 freeAgentPoolTokensWei, uint256 mintedUBA, uint256 reservedUBA, uint256 redeemingUBA, uint256 poolRedeemingUBA, uint256 dustUBA, uint256 liquidationStartTimestamp, uint256 maxLiquidationAmountUBA, uint256 liquidationPaymentFactorVaultBIPS, uint256 liquidationPaymentFactorPoolBIPS, int256 underlyingBalanceUBA, uint256 requiredUnderlyingBalanceUBA, int256 freeUnderlyingBalanceUBA, uint256 announcedUnderlyingWithdrawalId, uint256 buyFAssetByAgentFactorBIPS, uint256 poolExitCollateralRatioBIPS, uint256 redemptionPoolFeeShareBIPS))',
  'function redemptionQueue(uint256 _firstRedemptionTicketId, uint256 _pageSize) view returns ((uint256 redemptionTicketId, address agentVault, uint256 ticketValueUBA)[] _queue, uint256 _nextRedemptionTicketId)',
  'event RedemptionRequested(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, string paymentAddress, uint256 valueUBA, uint256 feeUBA, uint256 firstUnderlyingBlock, uint256 lastUnderlyingBlock, uint256 lastUnderlyingTimestamp, bytes32 paymentReference, address executor, uint256 executorFeeNatWei)',
  'event RedemptionWithTagRequested(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, string paymentAddress, uint256 valueUBA, uint256 feeUBA, uint256 firstUnderlyingBlock, uint256 lastUnderlyingBlock, uint256 lastUnderlyingTimestamp, bytes32 paymentReference, address executor, uint256 executorFeeNatWei, uint256 destinationTag)',
  'event RedemptionPerformed(address indexed agentVault, address indexed redeemer, uint64 indexed requestId, bytes32 transactionHash, uint256 redemptionAmountUBA, int256 spentUnderlyingUBA)',
  'event RedemptionDefault(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, uint256 redemptionAmountUBA, uint256 redeemedVaultCollateralWei, uint256 redeemedPoolCollateralWei)',
  'event RedemptionPaymentBlocked(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, bytes32 transactionHash, uint256 redemptionAmountUBA, int256 spentUnderlyingUBA)',
  'event RedemptionPaymentFailed(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, bytes32 transactionHash, int256 spentUnderlyingUBA, string failureReason)',
])

const AGENT_STATUS_NAMES = Object.freeze([
  'NORMAL',
  'LIQUIDATION',
  'FULL_LIQUIDATION',
  'DESTROYING',
  'DESTROYED',
])

export function createFassetPublicClient(rpcUrl = DEFAULT_RPC_URL) {
  return createPublicClient({
    chain: {
      id: COSTON2_CHAIN_ID,
      name: 'Flare Testnet Coston2',
      nativeCurrency: { name: 'Coston2 FLR', symbol: 'C2FLR', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl, {
      batch: { wait: RPC_BATCH_WAIT_MS, batchSize: RPC_BATCH_SIZE },
      timeout: RPC_TIMEOUT_MS,
      retryCount: RPC_RETRY_COUNT,
      retryDelay: RPC_RETRY_DELAY_MS,
    }),
  })
}

export async function fetchFassetSnapshot({
  rpcUrl = DEFAULT_RPC_URL,
  thresholds = DEFAULT_THRESHOLDS,
} = {}) {
  const client = createFassetPublicClient(rpcUrl)

  const [chainId, assetManagerAddress, ftsoAddress] = await Promise.all([
    client.getChainId(),
    readRegistryAddress(client, 'AssetManagerFXRP'),
    readRegistryAddress(client, 'FtsoV2'),
  ])

  if (chainId !== COSTON2_CHAIN_ID) {
    throw new Error(`Unsupported network: expected Coston2 chain ${COSTON2_CHAIN_ID}, got ${chainId}`)
  }

  // Resolve one observation block after the registry lookup and pin every
  // downstream read to it so the API never presents a mixed-block snapshot.
  const blockNumber = await client.getBlockNumber()

  const [
    fAssetAddress,
    lotSizeUBA,
    minimumRedeemAmountUBA,
    settingsResult,
    assetMintingGranularityUBA,
    assetMintingDecimals,
    emergencyPaused,
    emergencyPauseLevel,
    mintingPaused,
    currentUnderlyingBlock,
    collateralTypesResult,
    availableAgentsResult,
  ] = await Promise.all([
    readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'fAsset', [], undefined, blockNumber),
    readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'lotSize', [], undefined, blockNumber),
    readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'minimumRedeemAmountUBA', [], undefined, blockNumber),
    readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'getSettings', [], undefined, blockNumber),
    readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'assetMintingGranularityUBA', [], undefined, blockNumber),
    readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'assetMintingDecimals', [], undefined, blockNumber),
    readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'emergencyPaused', [], undefined, blockNumber),
    readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'emergencyPauseLevel', [], undefined, blockNumber),
    readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'mintingPaused', [], undefined, blockNumber),
    readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'currentUnderlyingBlock', [], undefined, blockNumber),
    readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'getCollateralTypes', [], undefined, blockNumber),
    readAvailableAgentsPage(client, assetManagerAddress, 0, AGENT_PAGE_SIZE, blockNumber),
  ])

  const availableAgents = await readAllAvailableAgents(
    client,
    assetManagerAddress,
    availableAgentsResult,
    blockNumber,
  )
  const collateralTypes = normalizeCollateralTypes(collateralTypesResult)
  const settings = normalizeSettings(settingsResult)
  const [queueEntries, assetMetadata, oracleResult] = await Promise.all([
    readAllRedemptionTickets(client, assetManagerAddress, blockNumber),
    readAssetMetadata(client, fAssetAddress, blockNumber),
    readContract(client, ftsoAddress, FTSO_ABI, 'getFeedById', [XRP_USD_FEED_ID], 0n, blockNumber),
  ])
  const redemptionAgentDescriptors = agentsForRedemptionPrefix(
    availableAgents,
    queueEntries,
    settings.maxRedeemedTickets,
  )
  const redemptionAgentInfos = await Promise.all(
    redemptionAgentDescriptors.map((agent) =>
      readContract(client, assetManagerAddress, ASSET_MANAGER_ABI, 'getAgentInfo', [agent.agentVault], undefined, blockNumber),
    ),
  )
  const infoByAgent = new Map(
    redemptionAgentDescriptors.map((agent, index) => [
      agent.agentVault.toLowerCase(),
      redemptionAgentInfos[index],
    ]),
  )
  const agents = normalizeAgents(
    availableAgents,
    availableAgents.map((agent) => infoByAgent.get(agent.agentVault.toLowerCase())),
    collateralTypes,
  )
  const redemptionAgentSet = normalizeAgents(
    redemptionAgentDescriptors,
    redemptionAgentInfos,
    collateralTypes,
  )
  const now = Math.floor(Date.now() / 1000)

  const oracle = normalizeOracle(oracleResult, now)
  const asset = normalizeAsset(
    assetMetadata,
    lotSizeUBA,
    minimumRedeemAmountUBA,
    assetMintingDecimals,
    assetMintingGranularityUBA,
  )
  const queue = normalizeQueue(queueEntries, lotSizeUBA)
  const protocol = normalizeProtocol(
    currentUnderlyingBlock,
    emergencyPaused,
    emergencyPauseLevel,
    mintingPaused,
    now,
  )

  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date(now * 1000).toISOString(),
    fetchedAtUnixSeconds: now,
    network: {
      name: 'Coston2',
      chainId,
      blockNumber: blockNumber.toString(),
      explorerUrl: COSTON2_EXPLORER,
    },
    source: {
      registry: FLARE_CONTRACT_REGISTRY,
      assetManager: assetManagerAddress,
      fAsset: fAssetAddress,
      ftsoV2: ftsoAddress,
      feedId: XRP_USD_FEED_ID,
    },
    asset,
    settings,
    oracle,
    queue,
    agents,
    redemptionAgents: {
      totalObserved: redemptionAgentSet.items.length,
      items: redemptionAgentSet.items,
    },
    collateralTypes,
    protocol,
  }

  return evaluateSnapshot(snapshot, thresholds)
}

function agentsForRedemptionPrefix(availableAgents, queueEntries, maxRedeemedTickets) {
  const descriptors = availableAgents.map((agent) => ({ ...agent, publiclyAvailable: true }))
  const seen = new Set(descriptors.map((agent) => agent.agentVault.toLowerCase()))
  const ticketCap = toBigInt(maxRedeemedTickets)
  if (ticketCap === null || ticketCap <= 0n) return descriptors

  const boundedCap = ticketCap > BigInt(MAX_QUEUE_TICKETS)
    ? MAX_QUEUE_TICKETS
    : Number(ticketCap)
  for (const ticket of queueEntries.slice(0, boundedCap)) {
    const agentVault = String(ticket?.agentVault || '')
    const key = agentVault.toLowerCase()
    if (!agentVault || seen.has(key)) continue
    descriptors.push({ agentVault, ownerManagementAddress: null, publiclyAvailable: false })
    seen.add(key)
  }
  return descriptors
}

async function readRegistryAddress(client, name) {
  const address = await readContract(
    client,
    FLARE_CONTRACT_REGISTRY,
    REGISTRY_ABI,
    'getContractAddressByName',
    [name],
  )
  if (!address || /^0x0{40}$/i.test(address)) {
    throw new Error(`Flare registry returned no address for ${name}`)
  }
  return address
}

async function readAssetMetadata(client, address, blockNumber) {
  const [symbol, decimals, totalSupply] = await Promise.all([
    readContract(client, address, ERC20_ABI, 'symbol', [], undefined, blockNumber),
    readContract(client, address, ERC20_ABI, 'decimals', [], undefined, blockNumber),
    readContract(client, address, ERC20_ABI, 'totalSupply', [], undefined, blockNumber),
  ])

  return { address, symbol, decimals, totalSupply }
}

async function readAvailableAgentsPage(client, address, start, pageSize, blockNumber) {
  return readContract(
    client,
    address,
    ASSET_MANAGER_ABI,
    'getAvailableAgentsDetailedList',
    [BigInt(start), BigInt(start + pageSize)],
    undefined,
    blockNumber,
  )
}

async function readAllAvailableAgents(client, address, firstResult, blockNumber) {
  const agents = normalizeAvailableAgents(tupleAt(firstResult, 0))
  const totalLength = safeNumber(tupleAt(firstResult, 1))

  if (totalLength === null || totalLength > MAX_AGENTS) {
    throw new Error(`FAsset agent list is too large to read safely (${String(tupleAt(firstResult, 1))})`)
  }

  let start = agents.length
  while (start < totalLength) {
    const page = await readAvailableAgentsPage(client, address, start, AGENT_PAGE_SIZE, blockNumber)
    const pageAgents = normalizeAvailableAgents(tupleAt(page, 0))
    if (pageAgents.length === 0) {
      throw new Error('FAsset agent list returned an empty page before its advertised end')
    }
    agents.push(...pageAgents)
    start += pageAgents.length
  }

  if (agents.length !== totalLength) {
    throw new Error(`FAsset agent list changed while reading (${agents.length}/${totalLength})`)
  }

  return agents
}

async function readAllRedemptionTickets(client, address, blockNumber) {
  const entries = []
  let cursor = 0n

  while (entries.length <= MAX_QUEUE_TICKETS) {
    const result = await readContract(
      client,
      address,
      ASSET_MANAGER_ABI,
      'redemptionQueue',
      [cursor, BigInt(QUEUE_PAGE_SIZE)],
      undefined,
      blockNumber,
    )
    const page = normalizeQueueEntries(tupleAt(result, 0))
    const nextCursor = toBigInt(tupleAt(result, 1))
    entries.push(...page)

    if (nextCursor === null || nextCursor === 0n) return entries
    if (nextCursor === cursor || page.length === 0) {
      throw new Error('FAsset redemption queue cursor did not advance')
    }
    if (entries.length > MAX_QUEUE_TICKETS) {
      throw new Error(`FAsset redemption queue exceeds safe read limit (${MAX_QUEUE_TICKETS} tickets)`)
    }
    cursor = nextCursor
  }

  throw new Error(`FAsset redemption queue exceeds safe read limit (${MAX_QUEUE_TICKETS} tickets)`)
}

function normalizeAvailableAgents(items = []) {
  return items.map((item, index) => ({
    agentVault: stringValue(item, 'agentVault', 0),
    ownerManagementAddress: stringValue(item, 'ownerManagementAddress', 1),
    feeBIPS: stringValue(item, 'feeBIPS', 2),
    mintingVaultCollateralRatioBIPS: stringValue(item, 'mintingVaultCollateralRatioBIPS', 3),
    mintingPoolCollateralRatioBIPS: stringValue(item, 'mintingPoolCollateralRatioBIPS', 4),
    freeCollateralLots: stringValue(item, 'freeCollateralLots', 5),
    status: statusName(stringValue(item, 'status', 6), index),
  }))
}

function normalizeAgents(availableAgents, infos, collateralTypes) {
  const normalized = availableAgents.map((available, index) => {
    const info = infos[index]
    const vaultCollateralToken = stringValue(info, 'vaultCollateralToken', 9)
    const poolWNatToken = stringValue(info, 'poolWNatToken', 16)
    const vaultType = collateralTypes.find(
      (type) => type.collateralClass === 'VAULT' && sameAddress(type.token, vaultCollateralToken),
    )
    const poolType = collateralTypes.find(
      (type) => type.collateralClass === 'POOL' && sameAddress(type.token, poolWNatToken),
    )
    const vaultRatioBIPS = stringValue(info, 'vaultCollateralRatioBIPS', 15)
    const poolRatioBIPS = stringValue(info, 'poolCollateralRatioBIPS', 19)
    const vaultStatus = statusFromRatio(
      vaultRatioBIPS,
      vaultType?.minCollateralRatioBIPS,
      vaultType?.safetyMinCollateralRatioBIPS,
    )
    const poolStatus = statusFromRatio(
      poolRatioBIPS,
      poolType?.minCollateralRatioBIPS,
      poolType?.safetyMinCollateralRatioBIPS,
    )
    const status = statusName(stringValue(info, 'status', 0), index)
    const healthStatus =
      status === 'NORMAL' ? worstStatus([vaultStatus, poolStatus]) : 'critical'

    return {
      agentVault: available.agentVault,
      ownerManagementAddress: available.ownerManagementAddress || stringValue(info, 'ownerManagementAddress', 1),
      publiclyAvailable: available.publiclyAvailable !== false,
      status,
      feeBIPS: stringValue(info, 'feeBIPS', 7),
      freeCollateralLots: stringValue(info, 'freeCollateralLots', 12),
      mintedUBA: stringValue(info, 'mintedUBA', 24),
      redeemingUBA: stringValue(info, 'redeemingUBA', 26),
      underlyingBalanceUBA: stringValue(info, 'underlyingBalanceUBA', 33),
      requiredUnderlyingBalanceUBA: stringValue(info, 'requiredUnderlyingBalanceUBA', 34),
      freeUnderlyingBalanceUBA: stringValue(info, 'freeUnderlyingBalanceUBA', 35),
      healthStatus,
      vaultCollateral: {
        token: vaultCollateralToken,
        ratioBIPS: vaultRatioBIPS,
        minimumRatioBIPS: vaultType?.minCollateralRatioBIPS ?? null,
        safetyRatioBIPS: vaultType?.safetyMinCollateralRatioBIPS ?? null,
        status: vaultStatus,
      },
      poolCollateral: {
        token: poolWNatToken,
        ratioBIPS: poolRatioBIPS,
        minimumRatioBIPS: poolType?.minCollateralRatioBIPS ?? null,
        safetyRatioBIPS: poolType?.safetyMinCollateralRatioBIPS ?? null,
        status: poolStatus,
      },
    }
  })

  const freeCollateralLots = normalized.reduce(
    (total, agent) => total + (toBigInt(agent.freeCollateralLots) ?? 0n),
    0n,
  )
  const healthSummary = normalized.reduce(
    (summary, agent) => {
      summary.total += 1
      if (agent.healthStatus === 'healthy') summary.healthy += 1
      if (agent.healthStatus === 'warning') summary.warning += 1
      if (agent.healthStatus === 'critical') summary.critical += 1
      if (agent.healthStatus === 'unknown') summary.unknown += 1
      return summary
    },
    { total: 0, healthy: 0, warning: 0, critical: 0, unknown: 0 },
  )

  return {
    totalAvailable: normalized.length,
    freeCollateralLots: freeCollateralLots.toString(),
    healthSummary,
    items: normalized,
  }
}

function normalizeCollateralTypes(result) {
  const items = Array.isArray(result?.[0]) ? result[0] : result
  return normalizeTupleArray(items).map((item) => ({
    collateralClass: collateralClassName(stringValue(item, 'collateralClass', 0)),
    token: stringValue(item, 'token', 1),
    decimals: safeNumber(stringValue(item, 'decimals', 2)),
    validUntil: stringValue(item, 'validUntil', 3),
    directPricePair: Boolean(valueAt(item, 'directPricePair', 4)),
    assetFtsoSymbol: stringValue(item, 'assetFtsoSymbol', 5),
    tokenFtsoSymbol: stringValue(item, 'tokenFtsoSymbol', 6),
    minCollateralRatioBIPS: stringValue(item, 'minCollateralRatioBIPS', 7),
    safetyMinCollateralRatioBIPS: stringValue(item, 'safetyMinCollateralRatioBIPS', 8),
  }))
}

function normalizeQueueEntries(items = []) {
  return normalizeTupleArray(items).map((item) => ({
    redemptionTicketId: stringValue(item, 'redemptionTicketId', 0),
    agentVault: stringValue(item, 'agentVault', 1),
    ticketValueUBA: stringValue(item, 'ticketValueUBA', 2),
  }))
}

function normalizeQueue(entries, lotSizeUBA) {
  const totalValueUBA = entries.reduce(
    (total, entry) => total + (toBigInt(entry.ticketValueUBA) ?? 0n),
    0n,
  )
  const lotSize = toBigInt(lotSizeUBA)

  return {
    ticketCount: entries.length,
    totalValueUBA: totalValueUBA.toString(),
    totalLots: lotSize && lotSize > 0n ? (totalValueUBA / lotSize).toString() : null,
    items: entries,
  }
}

function normalizeSettings(result) {
  return {
    assetUnitUBA: stringValue(result, 'assetUnitUBA', 17),
    lotSizeAMG: stringValue(result, 'lotSizeAMG', 19),
    mintingCapAMG: stringValue(result, 'mintingCapAMG', 22),
    underlyingBlocksForPayment: stringValue(result, 'underlyingBlocksForPayment', 23),
    underlyingSecondsForPayment: stringValue(result, 'underlyingSecondsForPayment', 24),
    redemptionFeeBIPS: stringValue(result, 'redemptionFeeBIPS', 25),
    maxRedeemedTickets: stringValue(result, 'maxRedeemedTickets', 30),
    maxTrustedPriceAgeSeconds: stringValue(result, 'maxTrustedPriceAgeSeconds', 34),
  }
}

function normalizeOracle(result, now) {
  const value = toBigInt(valueAt(result, 'value', 0))
  const decimals = safeNumber(valueAt(result, 'decimals', 1))
  const timestamp = safeNumber(valueAt(result, 'timestamp', 2))
  if (value === null || decimals === null || timestamp === null) {
    throw new Error('FTSO returned an invalid XRP/USD value')
  }

  return {
    feed: 'XRP/USD',
    feedId: XRP_USD_FEED_ID,
    rawValue: value.toString(),
    decimals,
    price: formatUnits(value, decimals),
    timestamp,
    timestampISO: new Date(timestamp * 1000).toISOString(),
    ageSeconds: Math.max(0, now - timestamp),
  }
}

function normalizeAsset(
  metadata,
  lotSizeUBA,
  minimumRedeemAmountUBA,
  assetMintingDecimals,
  assetMintingGranularityUBA,
) {
  const decimals = safeNumber(metadata.decimals)
  const lotDecimals = safeNumber(assetMintingDecimals)
  if (decimals === null || lotDecimals === null) {
    throw new Error('FAsset metadata returned invalid decimals')
  }

  const supply = toBigInt(metadata.totalSupply)
  const lotSize = toBigInt(lotSizeUBA)
  const minimumRedeemAmount = toBigInt(minimumRedeemAmountUBA)
  const granularity = toBigInt(assetMintingGranularityUBA)
  if (supply === null || lotSize === null || minimumRedeemAmount === null || granularity === null) {
    throw new Error('FAsset metadata returned invalid quantities')
  }

  return {
    symbol: String(metadata.symbol),
    decimals,
    address: metadata.address,
    totalSupplyUBA: supply.toString(),
    totalSupply: formatUnits(supply, decimals),
    lotSizeUBA: lotSize.toString(),
    lotSize: formatUnits(lotSize, lotDecimals),
    minimumRedeemAmountUBA: minimumRedeemAmount.toString(),
    minimumRedeemAmount: formatUnits(minimumRedeemAmount, decimals),
    assetMintingDecimals: lotDecimals,
    assetMintingGranularityUBA: granularity.toString(),
  }
}

function normalizeProtocol(result, emergencyPaused, emergencyPauseLevel, mintingPaused, now) {
  const blockNumber = stringValue(result, 'blockNumber', 0)
  const blockTimestamp = safeNumber(stringValue(result, 'blockTimestamp', 1))
  const lastUpdateTs = safeNumber(stringValue(result, 'lastUpdateTs', 2))

  return {
    emergencyPaused: Boolean(emergencyPaused),
    emergencyPauseLevel: safeNumber(emergencyPauseLevel),
    mintingPaused: Boolean(mintingPaused),
    currentUnderlyingBlock: {
      blockNumber,
      blockTimestamp,
      blockTimestampISO: blockTimestamp ? new Date(blockTimestamp * 1000).toISOString() : null,
      lastUpdateTs,
      lastUpdateTsISO: lastUpdateTs ? new Date(lastUpdateTs * 1000).toISOString() : null,
      ageSeconds: lastUpdateTs === null ? null : Math.max(0, now - lastUpdateTs),
    },
  }
}

async function readContract(client, address, abi, functionName, args = [], value, blockNumber) {
  return client.readContract({
    address,
    abi,
    functionName,
    args,
    ...(value === undefined ? {} : { value }),
    ...(blockNumber === undefined ? {} : { blockNumber }),
  })
}

function tupleAt(value, index) {
  return value?.[index] ?? value
}

function normalizeTupleArray(value) {
  return Array.isArray(value) ? value : []
}

function valueAt(value, name, index) {
  return value?.[name] ?? value?.[index]
}

function stringValue(value, name, index) {
  const item = valueAt(value, name, index)
  return item === null || item === undefined ? '' : String(item)
}

function toBigInt(value) {
  if (value === null || value === undefined || value === '') return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

function sameAddress(left, right) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase())
}

function collateralClassName(value) {
  const names = ['NONE', 'POOL', 'VAULT']
  const index = safeNumber(value)
  return index === null ? 'UNKNOWN' : names[index] ?? `UNKNOWN_${index}`
}

function statusName(value, fallbackIndex) {
  const index = safeNumber(value)
  return index === null
    ? `UNKNOWN_${fallbackIndex}`
    : AGENT_STATUS_NAMES[index] ?? `UNKNOWN_${index}`
}

function worstStatus(statuses) {
  const order = { healthy: 0, warning: 1, critical: 2, unknown: 3 }
  return statuses.reduce(
    (worst, current) => (order[current] > order[worst] ? current : worst),
    'healthy',
  )
}
