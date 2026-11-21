import {
  AmmoraDataApiClient,
  AmmoraSwapClient,
  DammV2Client,
  giwaSepoliaAutoRoutePoolProfiles,
  AmmoraV4LaunchCurveClient,
  ammoraLaunchFactoryV4Abi,
  buildClaimFeeVaultFor,
  buildCreateAmmoraV4Launch,
  classifyAmmoraV4ExactInputFill,
  createConfigAndPoolWithFirstBuy,
  deltaQuote,
  excludeAmmoraFee,
  includeAmmoraFee,
  feeVaultAbi,
  getAmmoraV4ConfigAtBlock,
  parseAmmoraV4LaunchCreatedReceipt,
  parseAmmoraV4MigratedReceipt,
  parseAmmoraV4SwapReceipt,
  segmentedExactInput,
  type AmmoraV4Config,
  type AmmoraV4ConfigSnapshot,
  type AmmoraV4LaunchCurveState,
  type AmmoraV4Segment,
} from "@ammora-protocol/sdk";
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from "viem";
import {
  DATA_API,
  WETH,
  core,
  ensureExactAllowance,
  giwaSepolia,
  launch,
  afterConfirmed,
  backgroundGate,
  balanceOf,
  withWalletPrompt,
  withTimeout,
  nativeBalance,
  deployment,
  freshBlockNumber,
  publicClient,
  logsClient,
  requireWallet,
  revokeLeftover,
  sendTx,
} from "./chain";

/** OrbitPad platform address: platform Config owner, partner, liquidity partner and leftover receiver. */
export const PARTNER: Address = "0x7dE71b1d5936985182d30336e1AF1Ec399b7178B";
/** Small graduation threshold so the full lifecycle fits in a couple of testnet buys. */
export const THRESHOLD_RAW = 10n ** 16n; // 0.01 WETH
export const SALE_TOKENS = 100_000_000n;
/**
 * OrbitPad's platform Config #46 (owner/partner = PARTNER, created at block 41534300). It is the single source of
 * OrbitPad economics: launches without a first buy use it directly, and first-buy launches register a copy of it
 * (same fees, split, curve and threshold) owned by the creator.
 */
export const ORBITPAD_CONFIG_ID = 46n;
/** Hash of Config #46 as created; a different hash means the ID no longer holds the economics we reviewed. */
export const ORBITPAD_CONFIG_HASH: Hex = "0xe455d29d4fe6a72ac5e93b4f9de7acbd81f7aaba9be2355720ed2c4623bc3c65";

export const platformConfigId = (): bigint => ORBITPAD_CONFIG_ID;

type Log = (msg: string) => void;

async function latestBlock() {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return block;
}

/** Thrown when Config #46 is readable but must not be used; the message is shown to users as is. */
export class PlatformConfigUnavailable extends Error {
  override name = "PlatformConfigUnavailable";
}

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

/** Reads Config #46 at one block and checks it still is OrbitPad's: hash, enabled, platform roles, threshold. */
export async function platformConfigAt(blockNumber: bigint): Promise<AmmoraV4ConfigSnapshot> {
  const id = ORBITPAD_CONFIG_ID;
  const s = await getAmmoraV4ConfigAtBlock(publicClient, core.configRegistry, id, blockNumber);
  if (s.configHash.toLowerCase() !== ORBITPAD_CONFIG_HASH.toLowerCase()) {
    throw new PlatformConfigUnavailable(`OrbitPad Config #${id} no longer matches the reviewed economics, so launches are paused.`);
  }
  if (!s.enabled) throw new PlatformConfigUnavailable(`OrbitPad Config #${id} is disabled on-chain, so launches are paused.`);
  const c = s.config;
  if (!same(s.identity.owner, PARTNER) || !same(c.partnerRecipient, PARTNER) || !same(c.leftoverReceiver, PARTNER)
    || !same(c.liquidityDistribution.partner, PARTNER) || !same(c.quoteToken, WETH)
    || c.migrationQuoteThreshold !== THRESHOLD_RAW || s.segments.length === 0) {
    throw new PlatformConfigUnavailable(`OrbitPad Config #${id} has unexpected roles or threshold, so launches are paused.`);
  }
  return s;
}

/** OrbitPad economics: Config #46 as registered (fees, split, LP ratios, curve, 0.01 WETH threshold, partner = platform). */
export function orbitpadConfig(snapshot: AmmoraV4ConfigSnapshot): { config: AmmoraV4Config; segments: readonly AmmoraV4Segment[] } {
  return { config: snapshot.config, segments: snapshot.segments };
}

export type LaunchInput = { name: string; symbol: string; description: string; firstBuyRaw: bigint; slippageBps: number };

export function metadataUri(input: { name: string; symbol: string; description: string }): string {
  const json = JSON.stringify({ name: input.name, symbol: input.symbol, description: input.description, app: "OrbitPad" });
  return `data:application/json;base64,${btoa(unescape(encodeURIComponent(json)))}`;
}

export function parseMetadata(uri: string): { description?: string } {
  try {
    if (uri.startsWith("data:application/json;base64,")) {
      return JSON.parse(decodeURIComponent(escape(atob(uri.slice(29)))));
    }
  } catch { /* not ours */ }
  return {};
}

/** Conservative fee for the first buy: scheduler cliff fee, plus headroom if dynamic fees can add more. */
const firstBuyFeeBps = (config: AmmoraV4Config) => BigInt(config.cliffFeeBps) + (config.dynamicFeeEnabled ? 100n : 0n);

/**
 * Expected first-buy output on a fresh curve (starting at startSqrtPrice), via the SDK's exact segmented math.
 * Fee is excluded from the input first; minimum applies the user's slippage on top.
 */
export function firstBuyQuote(config: AmmoraV4Config, segments: readonly AmmoraV4Segment[], includedQuoteIn: bigint, slippageBps: number) {
  const feeBps = firstBuyFeeBps(config);
  const { excluded } = excludeAmmoraFee(includedQuoteIn, feeBps);
  const swap = segmentedExactInput([...segments], config.startSqrtPrice, excluded, false);
  const minimum = swap.amountOut * BigInt(10_000 - slippageBps) / 10_000n;
  return { feeBps, excluded, expectedOut: swap.amountOut, minimum, amountLeft: swap.amountLeft };
}

/**
 * Largest first buy that leaves the curve below its graduation threshold. Graduation must be a separate
 * final fill + migrate, so the creation transaction itself may not fill the curve. Conservative in both
 * fee collection modes: the quote reserve can never reach the threshold from this input.
 */
export const maxFirstBuyRaw = (config: AmmoraV4Config, segments?: readonly AmmoraV4Segment[]) => {
  // Fee-free capacity of the whole curve (even a min-fee first swap cannot exceed it), minus a dust margin.
  const capacity = segments?.length
    ? segments.reduce((sum, seg) => sum + deltaQuote(seg.lowerSqrtPrice, seg.upperSqrtPrice, seg.liquidity, false), 0n)
    : config.migrationQuoteThreshold;
  const limit = capacity < config.migrationQuoteThreshold ? capacity : config.migrationQuoteThreshold;
  return (limit - 10n ** 12n) / 10n ** 12n * 10n ** 12n; // round down to 0.000001 WETH
};

/** OrbitPad first-buy economics at the latest block, for the launch form. */
export async function firstBuyContext() {
  const blockNumber = await publicClient.getBlockNumber();
  const { config, segments } = orbitpadConfig(await platformConfigAt(blockNumber));
  return { config, segments, max: maxFirstBuyRaw(config, segments) };
}

export async function createLaunch(input: LaunchInput, log: Log): Promise<{ token: Address; curve: Address }> {
  const { account } = await requireWallet();
  const uri = metadataUri(input);
  if (input.firstBuyRaw > 0n) return createWithFirstBuy(account, input, uri, log);

  const configId = ORBITPAD_CONFIG_ID;
  log(`Reading OrbitPad Config #${configId}…`);
  const block = await step(latestBlock(), "Reading the latest block");
  const snapshot = await step(platformConfigAt(block.number), `Reading Config #${configId}`);
  const built = buildCreateAmmoraV4Launch({
    name: input.name,
    symbol: input.symbol,
    metadataURI: uri,
    creatorMetadataURI: uri,
    tokenDecimals: snapshot.config.tokenDecimals,
  }, configId, snapshot.config.poolCreationFee);
  const receipt = await sendTx({ to: core.launchFactory, ...built }, "Create token", log);
  const created = parseAmmoraV4LaunchCreatedReceipt(receipt, core.launchFactory);
  return { token: created.token, curve: created.curve };
}

const STEP_TIMEOUT_MS = 30_000;
const PLAN_TIMEOUT_MS = 90_000;
/** One network step of a launch: fails with a clear message instead of leaving the button busy forever. */
const step = <T>(promise: Promise<T>, what: string, ms = STEP_TIMEOUT_MS) =>
  withTimeout(promise, ms, `${what} got no answer in ${ms / 1000} s: the network RPC is slow or rate-limited. Nothing was sent; try again in a minute.`);

/** Atomic path: approval (if needed) → replan at a fresh block → READY → one Config+token+first-buy transaction. */
async function createWithFirstBuy(account: Address, input: LaunchInput, uri: string, log: Log) {
  log("Checking your WETH balance…");
  const wethBalance = await step(publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [account] }), "Reading your WETH balance");
  if (wethBalance < input.firstBuyRaw) throw new Error("Not enough WETH. Use “Wrap ETH → WETH” first.");

  const plan = async () => {
    log("Reading the latest block…");
    const block = await step(latestBlock(), "Reading the latest block");
    log(`Reading OrbitPad Config #${ORBITPAD_CONFIG_ID} at block ${block.number}…`);
    const { config, segments } = orbitpadConfig(await step(platformConfigAt(block.number), `Reading Config #${ORBITPAD_CONFIG_ID}`));
    const max = maxFirstBuyRaw(config, segments);
    if (input.firstBuyRaw > max) {
      throw new Error(`First buy can be at most ${fmt(max, 18)} WETH: it may not fill the curve`);
    }
    const q = firstBuyQuote(config, segments, input.firstBuyRaw, input.slippageBps);
    log(`Quote @${block.number}: ${fmt(input.firstBuyRaw, 18)} WETH (fee ≤${Number(q.feeBps) / 100}%) → ≈${fmt(q.expectedOut, config.tokenDecimals, 2)} ${input.symbol}, minOut ${fmt(q.minimum, config.tokenDecimals, 2)}`);
    if (q.amountLeft > 0n) throw new Error("First buy would fill the curve; use a smaller amount");
    if (q.minimum <= 0n) throw new Error("First buy too small to receive tokens");
    const minimum = q.minimum;
    log("Reading gas price…");
    const fees = await step(publicClient.estimateFeesPerGas(), "Reading gas price");
    log("Planning with the Ammora SDK (verifies contracts, allowance and gas at this block)…");
    return step(createConfigAndPoolWithFirstBuy(publicClient, {
      account,
      config,
      segments,
      launch: { name: input.name, symbol: input.symbol, metadataURI: uri, creatorMetadataURI: uri, tokenDecimals: config.tokenDecimals },
      firstBuys: [{ includedQuoteAmountRaw: input.firstBuyRaw, minimumBaseAmountOutRaw: minimum, allowPartialFill: false, recipient: account }],
      deadline: block.timestamp + 1800n,
      gas: { maxFeePerGasNativeRaw: (fees.maxFeePerGas ?? 1_000_000_000n) * 2n, safetyMarginBps: 2_000n },
      blockNumber: block.number,
    }), "Planning the launch transaction", PLAN_TIMEOUT_MS);
  };

  log("Previewing atomic Config + launch + first buy…");
  let result = await plan();
  log(result.status === "APPROVAL_REQUIRED" ? `Plan: an exact WETH approval is needed first.` : `Plan: ${result.status}.`);
  if (result.status === "APPROVAL_REQUIRED") {
    if (result.transaction.to.toLowerCase() !== WETH.toLowerCase()) throw new Error("Unexpected approval target");
    await sendTx(result.transaction, `Approve ${fmt(result.totalQuoteAmountRaw, 18)} WETH`, log);
    log("Re-planning at a fresh block…");
    result = await plan();
  }
  if (result.status !== "READY") throw new Error(`Expected READY after approval, got ${result.status}`);
  if (result.transaction.to.toLowerCase() !== launch.firstBuyExecutor.toLowerCase()
    && result.transaction.to.toLowerCase() !== core.launchFactory.toLowerCase()
    && result.transaction.to.toLowerCase() !== core.configRegistry.toLowerCase()) {
    log(`Note: atomic transaction target ${result.transaction.to}`);
  }
  const receipt = await sendTx(result.transaction, "Create Config + token + first buy", log);
  const created = parseAmmoraV4LaunchCreatedReceipt(receipt, core.launchFactory);
  return { token: created.token, curve: created.curve };
}

// ---------- Discovery ----------

export type LaunchStatus = "Trading" | "Ready to migrate" | "Graduated" | "Pending";
export type LaunchRow = {
  token: Address;
  curve: Address;
  creator: Address;
  configId: bigint;
  metadataURI: string;
  block: bigint;
  source: "api" | "rpc";
};

const STATUS_FROM_API: Record<string, LaunchStatus> = {
  PENDING: "Pending", ACTIVE: "Trading", MIGRATION_READY: "Ready to migrate", MIGRATED: "Graduated", FLAGGED: "Pending",
};
export const statusLabel = (status: number): LaunchStatus =>
  status === 1 ? "Trading" : status === 2 ? "Ready to migrate" : status === 3 ? "Graduated" : "Pending";

/** Data API failures are remembered briefly, so re-rendering the list doesn't wait out its timeout again. */
let dataApiDownUntil = 0;
const DATA_API_TIMEOUT_MS = 6_000;
const DATA_API_DOWN_MS = 120_000;
/** If the Data API hasn't answered by then, the RPC log scan starts alongside it instead of after its timeout. */
const LOG_SCAN_HEAD_START_MS = 1_500;

export async function recentLaunches(limit = 24): Promise<{ rows: LaunchRow[]; source: "api" | "rpc"; apiStatus?: Record<string, LaunchStatus> }> {
  if (Date.now() < dataApiDownUntil) return { rows: await launchesFromLogs(limit), source: "rpc" };
  let logs: Promise<LaunchRow[]> | undefined;
  const startLogs = () => (logs ??= launchesFromLogs(limit));
  const headStart = setTimeout(() => void startLogs().catch(() => {}), LOG_SCAN_HEAD_START_MS);
  try {
    const api = new AmmoraDataApiClient(DATA_API);
    const page = await api.getLaunches({ chainId: BigInt(giwaSepolia.id), signal: AbortSignal.timeout(DATA_API_TIMEOUT_MS) });
    const items = page.items.filter(item => item.protocolVersion === 4).slice(0, limit);
    const apiStatus: Record<string, LaunchStatus> = {};
    const rows = items.map(item => {
      apiStatus[item.curveAddress.toLowerCase()] = STATUS_FROM_API[item.status] ?? "Pending";
      return {
        token: getAddress(item.address), curve: getAddress(item.curveAddress), creator: getAddress(item.creatorAddress),
        configId: BigInt(item.configId), metadataURI: item.metadataUri, block: BigInt(item.createdBlock), source: "api" as const,
      };
    });
    rows.sort((a, b) => Number(b.block - a.block));
    return { rows, source: "api", apiStatus };
  } catch {
    dataApiDownUntil = Date.now() + DATA_API_DOWN_MS;
    return { rows: await startLogs(), source: "rpc" };
  } finally {
    clearTimeout(headStart);
  }
}

const launchCreatedEvent = ammoraLaunchFactoryV4Abi.find(
  (item): item is Extract<(typeof ammoraLaunchFactoryV4Abi)[number], { type: "event"; name: "LaunchCreated" }> =>
    item.type === "event" && item.name === "LaunchCreated",
)!;

/** Fallback: scan LaunchCreated on the V4 factory backwards in fixed windows. */
export async function launchesFromLogs(limit: number, windows = 12, span = 10_000n): Promise<LaunchRow[]> {
  const head = await logsClient.getBlockNumber();
  const rows: LaunchRow[] = [];
  let to = head;
  for (let i = 0; i < windows && rows.length < limit && to > deploymentStart; i++) {
    const from = to - span + 1n > deploymentStart ? to - span + 1n : deploymentStart;
    const logs = await logsClient.getLogs({ address: core.launchFactory, event: launchCreatedEvent, fromBlock: from, toBlock: to });
    for (const log of logs.reverse()) {
      rows.push({
        token: log.args.token!, curve: log.args.curve!, creator: log.args.creator!, configId: log.args.configId!,
        metadataURI: log.args.metadataURI ?? "", block: log.blockNumber, source: "rpc",
      });
    }
    to = from - 1n;
  }
  return rows.slice(0, limit);
}
const deploymentStart = 36_220_000n;

/** Finds the LaunchCreated log for one curve (metadata/description lookup). */
export async function findLaunch(curve: Address, creationHint?: bigint): Promise<LaunchRow | null> {
  const head = await logsClient.getBlockNumber();
  const ranges: Array<[bigint, bigint]> = [];
  if (creationHint) ranges.push([creationHint, creationHint]);
  for (let to = head, i = 0; i < 30 && to > deploymentStart; i++) {
    const from = to - 9_999n > deploymentStart ? to - 9_999n : deploymentStart;
    ranges.push([from, to]);
    to = from - 1n;
  }
  for (const [fromBlock, toBlock] of ranges) {
    const logs = await logsClient.getLogs({ address: core.launchFactory, event: launchCreatedEvent, args: { curve }, fromBlock, toBlock });
    const log = logs[0];
    if (log) {
      return { token: log.args.token!, curve, creator: log.args.creator!, configId: log.args.configId!, metadataURI: log.args.metadataURI ?? "", block: log.blockNumber, source: "rpc" };
    }
  }
  return null;
}

// ---------- Curve ----------

export const curveClient = (curve: Address) => new AmmoraV4LaunchCurveClient(publicClient, curve, core);

export type CurveView = {
  state: AmmoraV4LaunchCurveState;
  progressBps: number;
  name: string;
  symbol: string;
  baseDecimals: number;
  segments: readonly AmmoraV4Segment[];
  config: AmmoraV4Config;
};

// Last successfully read data, kept in memory and localStorage so a rate-limited RPC isn't a dead end.
const curveCache = new Map<string, { view: CurveView; at: number }>();
const CACHE_PREFIX = "orbitpad-curve:";
const toJson = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? { __b: v.toString() } : v));
const fromJson = <T>(text: string): T =>
  JSON.parse(text, (_, v) => (v && typeof v === "object" && typeof v.__b === "string" ? BigInt(v.__b) : v));

export function cachedCurve(curve: Address): { view: CurveView; at: number } | null {
  const key = curve.toLowerCase();
  const hit = curveCache.get(key);
  if (hit) return hit;
  try {
    const stored = localStorage.getItem(CACHE_PREFIX + key);
    if (stored) {
      const parsed = fromJson<{ view: CurveView; at: number }>(stored);
      curveCache.set(key, parsed);
      return parsed;
    }
  } catch { /* storage unavailable or corrupt */ }
  return null;
}

export async function readCurve(curve: Address): Promise<CurveView> {
  const view = await readCurveLive(curve);
  const entry = { view, at: Date.now() };
  curveCache.set(curve.toLowerCase(), entry);
  try { localStorage.setItem(CACHE_PREFIX + curve.toLowerCase(), toJson(entry)); } catch { /* ignore */ }
  return view;
}

async function readCurveLive(curve: Address): Promise<CurveView> {
  const client = curveClient(curve);
  const blockNumber = await freshBlockNumber();
  const state = await client.getStateAtBlock(blockNumber);
  const [name, symbol, baseDecimals, snapshot] = await Promise.all([
    publicClient.readContract({ address: state.baseToken, abi: erc20Abi, functionName: "name", blockNumber }),
    publicClient.readContract({ address: state.baseToken, abi: erc20Abi, functionName: "symbol", blockNumber }),
    publicClient.readContract({ address: state.baseToken, abi: erc20Abi, functionName: "decimals", blockNumber }),
    getAmmoraV4ConfigAtBlock(publicClient, core.configRegistry, state.configId, blockNumber),
  ]);
  return { state, progressBps: progressOf(state), name, symbol, baseDecimals, segments: snapshot.segments, config: snapshot.config };
}

/** OrbitPad launch: on the platform Config, or an atomic first-buy Config whose partner is the platform. */
export const isOrbitPadLaunch = (state: Pick<AmmoraV4LaunchCurveState, "configId" | "partnerRecipient">) =>
  state.configId === ORBITPAD_CONFIG_ID || state.partnerRecipient.toLowerCase() === PARTNER.toLowerCase();

/** Exact percentage string that stays readable for tiny progress against huge thresholds. */
/** One-line progress summary; after the final fill the curve reserve is no longer the amount raised. */
export function progressSummary(state: Pick<AmmoraV4LaunchCurveState, "status" | "quoteReserve" | "migrationQuoteThreshold">): string {
  const threshold = `${fmt(state.migrationQuoteThreshold, 18, 6)} WETH`;
  if (state.status === 3) return `Graduated · raised ${threshold}`;
  if (state.status === 2) return `Ready to migrate · raised ${threshold}`;
  return `${progressText(state)} to graduation · ${fmt(state.quoteReserve, 18, 6)} / ${threshold}`;
}

export function progressText(state: Pick<AmmoraV4LaunchCurveState, "status" | "quoteReserve" | "migrationQuoteThreshold">): string {
  if (state.status >= 2) return "100%";
  if (state.migrationQuoteThreshold === 0n || state.quoteReserve === 0n) return "0%";
  const ppm = state.quoteReserve * 1_000_000n / state.migrationQuoteThreshold; // parts per million
  if (ppm === 0n) return "<0.0001%";
  if (ppm < 100n) return `${(Number(ppm) / 10_000).toFixed(4)}%`;
  return `${(Number(ppm) / 10_000).toFixed(1)}%`;
}

export function progressOf(state: Pick<AmmoraV4LaunchCurveState, "status" | "quoteReserve" | "migrationQuoteThreshold">): number {
  if (state.status >= 2) return 10_000;
  if (state.migrationQuoteThreshold === 0n) return 0;
  const bps = Number(state.quoteReserve * 10_000n / state.migrationQuoteThreshold);
  return Math.min(10_000, bps);
}

const ROW_TTL_MS = 30_000;
const rowStates = new Map<string, { state: AmmoraV4LaunchCurveState; at: number }>();
const tokenNames = new Map<string, { name: string; symbol: string }>();

/** Lightweight list status: state (cached 30 s, waits for the background gate) + token name (cached). */
export async function readRowState(curve: Address, maxAgeMs = ROW_TTL_MS): Promise<{ state: AmmoraV4LaunchCurveState; name: string; symbol: string }> {
  const key = curve.toLowerCase();
  let entry = rowStates.get(key);
  if (!entry || Date.now() - entry.at > maxAgeMs) {
    await backgroundGate();
    entry = { state: await curveClient(curve).getStateAtBlock(await freshBlockNumber()), at: Date.now() };
    rowStates.set(key, entry);
  }
  const state = entry.state;
  let names = tokenNames.get(state.baseToken.toLowerCase());
  if (!names) {
    const [name, symbol] = await Promise.all([
      publicClient.readContract({ address: state.baseToken, abi: erc20Abi, functionName: "name" }),
      publicClient.readContract({ address: state.baseToken, abi: erc20Abi, functionName: "symbol" }),
    ]);
    names = { name, symbol };
    tokenNames.set(state.baseToken.toLowerCase(), names);
  }
  return { state, ...names };
}

/** Drops cached list state after one of our transactions so the list shows it. */
export const invalidateRows = () => rowStates.clear();

// ---------- Trading ----------

export type TradePreview = {
  kind: "full" | "graduation-boundary" | "terminal-dust" | "partial";
  amountOut: bigint;
  minimumOut: bigint;
  consumed: bigint;
  refundable: bigint;
  fee: bigint;
};

export async function previewTrade(curve: Address, side: "buy" | "sell", amountIn: bigint, slippageBps: number): Promise<TradePreview> {
  const client = curveClient(curve);
  const baseForQuote = side === "sell";
  const blockNumber = await freshBlockNumber();
  const quote = await client.quoteExactInputAtBlock(amountIn, baseForQuote, blockNumber);
  const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
  return {
    kind: fill.kind,
    amountOut: quote.amountOut,
    minimumOut: quote.amountOut * BigInt(10_000 - slippageBps) / 10_000n,
    consumed: fill.consumedAmountIn,
    refundable: fill.refundableAmountIn,
    fee: quote.fee,
  };
}

export async function executeTrade(curve: Address, side: "buy" | "sell", amountIn: bigint, slippageBps: number, log: Log) {
  const { account } = await requireWallet();
  const client = curveClient(curve);
  const baseForQuote = side === "sell";

  const freshPlan = async () => {
    const blockNumber = await freshBlockNumber();
    const block = await publicClient.getBlock({ blockNumber });
    const quote = await client.quoteExactInputAtBlock(amountIn, baseForQuote, blockNumber);
    const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
    if (fill.kind === "terminal-dust") throw new Error("Remaining curve output rounds to zero (terminal dust). Not sending.");
    if (fill.kind === "partial") throw new Error("This amount cannot be filled in full. Try a smaller amount.");
    // Partial fill is enabled only for the graduation boundary, never globally.
    const plan = await client.planSwapExactInput({
      includedAmountIn: amountIn,
      baseForQuote,
      allowPartialFill: fill.allowPartialFill,
      slippageBps,
      recipient: account,
      deadline: block.timestamp + 600n,
    });
    const recheck = classifyAmmoraV4ExactInputFill(plan.quote, baseForQuote);
    if (recheck.kind !== fill.kind) throw new Error("Quote changed between preview and plan; try again");
    return { plan, fill };
  };

  log("Fresh quote…");
  let { plan, fill } = await freshPlan();
  if (fill.kind === "graduation-boundary") {
    log(`Final buy: ${fmt(fill.consumedAmountIn, 18)} WETH will be used, ${fmt(fill.refundableAmountIn, 18)} stays in your wallet.`);
  }
  const req = plan.approvalRequirement;
  await ensureExactAllowance(req.token, req.spender, req.amount, log);
  ({ plan, fill } = await freshPlan());
  const receipt = await sendTx(plan.transaction, side === "buy" ? "Buy" : "Sell", log);
  const swap = parseAmmoraV4SwapReceipt(receipt, curve, {
    trader: account, recipient: account, baseForQuote, requestedAmountIn: amountIn, minimumAmountOut: plan.quote.minimumAmountOut,
  });
  await revokeLeftover(req.token, req.spender, log);
  return swap;
}

export async function migrate(curve: Address, log: Log): Promise<Address> {
  const { account } = await requireWallet();
  const client = curveClient(curve);
  const blockNumber = await freshBlockNumber();
  const state = await client.getStateAtBlock(blockNumber);
  if (state.status === 3) return state.canonicalPool;
  if (state.status !== 2) throw new Error("Curve is not ReadyToMigrate");
  const plan = await client.planMigrateAtBlock(blockNumber);
  await publicClient.call({ account, to: plan.transaction.to, data: plan.transaction.data, value: plan.transaction.value, blockNumber });
  const receipt = await sendTx(plan.transaction, "Migrate", log);
  try {
    parseAmmoraV4MigratedReceipt(receipt, curve);
  } catch (error) {
    log(`Receipt parse warning: ${(error as Error).message}`);
  }
  const after = await client.getStateAtBlock(receipt.blockNumber);
  return after.canonicalPool;
}

// ---------- Graduated pool trading ----------

let swapClient: Promise<AmmoraSwapClient> | null = null;
const swaps = () => (swapClient ??= AmmoraSwapClient.create(publicClient, {
  deploymentCatalog: { [giwaSepolia.id]: deployment },
  factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
  quoteTtlMs: 30_000,
}).catch(error => { swapClient = null; throw error; }));

/** Fresh quote + plan for an exact-input swap in the graduated concentrated pool. */
export async function preparePoolSwap(pool: Address, tokenIn: Address, amountIn: bigint, slippageBps: number, payer: Address) {
  const client = await swaps();
  return client.prepareExactIn({
    model: "concentrated",
    pool,
    tokenIn,
    inputAsset: "erc20",
    amountIn,
    payer,
    recipient: payer,
    slippageBps,
    executionMode: "direct-wallet",
    quoteBlockNumber: await freshBlockNumber(),
  });
}

export async function executePoolSwap(pool: Address, tokenIn: Address, amountIn: bigint, slippageBps: number, log: Log) {
  const { client, account } = await requireWallet();
  log("Fresh pool quote…");
  const prepared = await preparePoolSwap(pool, tokenIn, amountIn, slippageBps, account);
  if (prepared.quote.remainderAmountIn > 0n) throw new Error("Pool cannot fill this amount in full; try a smaller amount");
  const spenders = prepared.approvalRequirements.map(r => r.spender);
  const result = await withWalletPrompt(() => prepared.execute(client, {
    autoRefresh: true,
    sendApprovals: true,
    exactApproval: true,
    simulate: true,
    onStatus: status => {
      if (status.type === "quote-refreshed") log(`Quote refreshed: min out ${status.quote.minimumAmountOut}`);
      else if (status.type === "approval-requested") log("Approve exact amount: confirm in your wallet…");
      else if (status.type === "approval-confirmed") log(`Approval confirmed in block ${status.blockNumber}`);
      else if (status.type === "swap-requested") log("Swap: confirm in your wallet…");
      else if (status.type === "swap-submitted") log(`Swap submitted ${status.hash.slice(0, 10)}…`);
      else if (status.type === "swap-confirmed") log(`Swap confirmed in block ${status.blockNumber}`);
    },
  }));
  for (const spender of spenders) await revokeLeftover(tokenIn, spender, log);
  await afterConfirmed(result.receipt, "Pool swap", log);
  return result;
}

// ---------- Fee split / claims ----------

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

/** Human-readable Creator/Partner economics from a Config. */
export function feeSplit(config: AmmoraV4Config): Array<[string, string]> {
  const ld = config.liquidityDistribution;
  const creatorLp = 10_000 - ld.partnerUnlockedBps - ld.partnerPermanentLockedBps - ld.creatorPermanentLockedBps;
  return [
    ["Starting trading fee", pct(config.cliffFeeBps)],
    ["Trading fees (after protocol) → Creator", pct(config.creatorShareOfNonProtocolBps)],
    ["Trading fees (after protocol) → Partner", pct(10_000 - config.creatorShareOfNonProtocolBps)],
    ["Graduation fee", pct(config.migrationQuoteFeeBps)],
    ["Graduation fee share → Creator", pct(config.creatorMigrationFeeShareBps)],
    ["LP → Partner (unlocked / locked)", `${pct(ld.partnerUnlockedBps)} / ${pct(ld.partnerPermanentLockedBps)}`],
    ["LP → Creator (locked / other)", `${pct(ld.creatorPermanentLockedBps)} / ${pct(creatorLp)}`],
  ];
}

/** Creator/Partner split of OrbitPad's platform Config #46 at the latest block. */
export async function platformSplit(): Promise<Array<[string, string]>> {
  const blockNumber = await publicClient.getBlockNumber();
  return feeSplit((await platformConfigAt(blockNumber)).config);
}

async function factoryFeeVault(): Promise<Address> {
  return publicClient.readContract({ address: core.launchFactory, abi: ammoraLaunchFactoryV4Abi, functionName: "feeVault" }) as Promise<Address>;
}

export type Claimable = { vault: Address; quote: bigint; base: bigint };

/** Fees accrued to `beneficiary` in the launch FeeVault (quote is shared across all of their launches). */
export async function claimableFees(state: AmmoraV4LaunchCurveState, beneficiary: Address): Promise<Claimable> {
  const vault = await factoryFeeVault();
  if (vault.toLowerCase() !== state.feeVault.toLowerCase()) throw new Error("Curve fee vault does not match the factory fee vault");
  const blockNumber = await freshBlockNumber();
  const read = (token: Address) =>
    publicClient.readContract({ address: vault, abi: feeVaultAbi, functionName: "claimable", args: [token, beneficiary], blockNumber }) as Promise<bigint>;
  const [quote, base] = await Promise.all([read(state.quoteToken), read(state.baseToken)]);
  return { vault, quote, base };
}

/** claimFor the connected account's own entitlement, paid to itself. One token per transaction. */
export async function claimFees(vault: Address, token: Address, log: Log): Promise<void> {
  const { account } = await requireWallet();
  const owed = (await publicClient.readContract({ address: vault, abi: feeVaultAbi, functionName: "claimable", args: [token, account] })) as bigint;
  if (owed === 0n) throw new Error("Nothing to claim for this token");
  const tx = buildClaimFeeVaultFor(token, account, account);
  await sendTx({ to: vault, data: tx.data }, "Claim fees", log);
}

export async function unwrapWeth(amount: bigint, log: Log) {
  await sendTx({ to: WETH, data: encodeFunctionData({ abi: wethWithdrawAbi, functionName: "withdraw", args: [amount] }) }, "Unwrap WETH", log);
}
const wethWithdrawAbi = [{ type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] }] as const;

/** ETH kept aside for gas when wrapping for a buy (approve + swap on GIWA with headroom). */
export async function gasReserve(): Promise<bigint> {
  const fees = await publicClient.estimateFeesPerGas();
  const perGas = fees.maxFeePerGas ?? 1_000_000_000n;
  const reserve = perGas * 1_500_000n;
  const floor = 10n ** 14n; // never reserve less than 0.0001 ETH
  return reserve > floor ? reserve : floor;
}

/** How much more WETH is needed for `amount`, and whether ETH can cover it plus gas. */
export async function wrapShortfall(account: Address, amount: bigint) {
  const [weth, eth, reserve] = await Promise.all([balanceOf(WETH, account), nativeBalance(account), gasReserve()]);
  const missing = amount > weth ? amount - weth : 0n;
  return { weth, eth, reserve, missing, canWrap: missing > 0n && eth >= missing + reserve };
}

// ---------- Graduated pool state ----------

export type PoolView = { price: number; sqrtPrice: bigint; feeBps: number; baseToken: Address; quoteToken: Address };

export async function readPool(pool: Address, baseDecimals: number): Promise<PoolView> {
  await freshBlockNumber();
  const client = new DammV2Client(publicClient, pool, "concentrated", launch.concentratedFactory, launch.concentratedPositionManager);
  const state = await client.getPoolState();
  return { price: priceFromSqrt(state.sqrtPrice, baseDecimals), sqrtPrice: state.sqrtPrice, feeBps: state.currentFeeBps, baseToken: state.baseToken, quoteToken: state.quoteToken };
}

/** Raw quote value of a raw base amount at a Q64.64 sqrt price (exact integer math). */
export const valueAtSqrtPrice = (baseRaw: bigint, sqrtPrice: bigint) => (baseRaw * sqrtPrice * sqrtPrice) >> 128n;

export async function wrapEth(amount: bigint, log: Log) {
  await sendTx({ to: WETH, data: "0xd0e30db0", value: amount }, "Wrap ETH", log);
}

// ---------- Formatting / curve math ----------

export function fmt(raw: bigint, decimals: number, digits = 6): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  let frac = (value % scale).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  const wholeStr = whole.toLocaleString("en-US");
  if (!frac && whole === 0n && value > 0n) return `${negative ? "-" : ""}<0.${"0".repeat(digits - 1)}1`;
  return `${negative ? "-" : ""}${wholeStr}${frac ? `.${frac}` : ""}`;
}

/** Human price (WETH per token) from a Q64.64 sqrt price. */
export function priceFromSqrt(sqrtPrice: bigint, baseDecimals: number, quoteDecimals = 18): number {
  const s = Number(sqrtPrice) / 2 ** 64;
  return s * s * 10 ** (baseDecimals - quoteDecimals);
}

/** Points along the curve: x = WETH raised, y = price. Amounts use the SDK's Q64 liquidity math. */
export function curvePoints(segments: readonly AmmoraV4Segment[], baseDecimals: number, samples = 64) {
  const points: Array<{ x: number; y: number }> = [];
  let raised = 0;
  for (const seg of segments) {
    for (let i = 0; i <= samples; i++) {
      const s = seg.lowerSqrtPrice + (seg.upperSqrtPrice - seg.lowerSqrtPrice) * BigInt(i) / BigInt(samples);
      const quote = s > seg.lowerSqrtPrice ? deltaQuote(seg.lowerSqrtPrice, s, seg.liquidity, false) : 0n;
      points.push({ x: raised + Number(quote) / 1e18, y: priceFromSqrt(s, baseDecimals) });
    }
    raised += Number(deltaQuote(seg.lowerSqrtPrice, seg.upperSqrtPrice, seg.liquidity, false)) / 1e18;
  }
  return points;
}

export function raisedAt(segments: readonly AmmoraV4Segment[], sqrtPrice: bigint): number {
  let raised = 0;
  for (const seg of segments) {
    const upper = sqrtPrice < seg.upperSqrtPrice ? sqrtPrice : seg.upperSqrtPrice;
    if (upper > seg.lowerSqrtPrice) raised += Number(deltaQuote(seg.lowerSqrtPrice, upper, seg.liquidity, false)) / 1e18;
  }
  return raised;
}

export const tokenBalance = balanceOf;

/** WETH (fee-included) needed to take the curve from its current price to graduation, rounded up. */
export async function quoteToGraduate(curve: Address, segments: readonly AmmoraV4Segment[]): Promise<bigint> {
  const state = await curveClient(curve).getStateAtBlock(await freshBlockNumber());
  let needed = 0n;
  for (const seg of segments) {
    const from = state.sqrtPrice > seg.lowerSqrtPrice ? state.sqrtPrice : seg.lowerSqrtPrice;
    if (seg.upperSqrtPrice > from) needed += deltaQuote(from, seg.upperSqrtPrice, seg.liquidity, true);
  }
  if (needed === 0n) return 0n;
  const feeBps = BigInt(state.currentFeeBps + state.currentDynamicFeeBps);
  return includeAmmoraFee(needed, feeBps).included + 1n;
}

