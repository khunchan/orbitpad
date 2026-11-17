import {
  AmmoraDataApiClient,
  AmmoraV4LaunchCurveClient,
  ammoraLaunchFactoryV4Abi,
  buildClaimFeeVaultFor,
  buildCreateAmmoraV4Launch,
  classifyAmmoraV4ExactInputFill,
  createConfigAndPoolWithFirstBuy,
  feeVaultAbi,
  getAmmoraV4ConfigAtBlock,
  parseAmmoraV4ConfigCreatedReceipt,
  parseAmmoraV4LaunchCreatedReceipt,
  parseAmmoraV4MigratedReceipt,
  parseAmmoraV4SwapReceipt,
  planCreateAmmoraV4Config,
  type AmmoraV4Config,
  type AmmoraV4ConfigSnapshot,
  type AmmoraV4LaunchCurveState,
  type AmmoraV4Segment,
} from "@ammora-protocol/sdk";
import { erc20Abi, getAddress, type Address, type Hex } from "viem";
import {
  DATA_API,
  WETH,
  core,
  ensureExactAllowance,
  giwaSepolia,
  launch,
  publicClient,
  requireWallet,
  revokeLeftover,
  sendTx,
} from "./chain";
import { deriveConfigFromTemplate } from "./config-from-template";

// GIWA Sepolia reviewed template (Config #6, concentrated graduation).
export const TEMPLATE_ID = 6n;
export const TEMPLATE_HASH: Hex = "0x6048908774397e0691bb0e19f72dabb790eb0d892d6081d3622b39e7f738e667";
/** OrbitPad platform address: platform Config owner, partner, liquidity partner and leftover receiver. */
export const PARTNER: Address = "0x7dE71b1d5936985182d30336e1AF1Ec399b7178B";
/** Small graduation threshold so the full lifecycle fits in a couple of testnet buys. */
export const THRESHOLD_RAW = 10n ** 16n; // 0.01 WETH
export const SALE_TOKENS = 100_000_000n;
/** OrbitPad's platform Config #46 (owner/partner = PARTNER, created at block 41534300). */
export const ORBITPAD_CONFIG_ID: bigint | null = 46n;

const CONFIG_KEY = "orbitpad-config-id";
export function platformConfigId(): bigint | null {
  if (ORBITPAD_CONFIG_ID !== null) return ORBITPAD_CONFIG_ID;
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored && /^\d+$/.test(stored)) return BigInt(stored);
  } catch { /* storage unavailable */ }
  return ORBITPAD_CONFIG_ID;
}
function rememberConfigId(id: bigint) {
  try { localStorage.setItem(CONFIG_KEY, id.toString()); } catch { /* ignore */ }
}

type Log = (msg: string) => void;

async function latestBlock() {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return block;
}

async function templateAt(blockNumber: bigint): Promise<AmmoraV4ConfigSnapshot> {
  const template = await getAmmoraV4ConfigAtBlock(publicClient, core.configRegistry, TEMPLATE_ID, blockNumber);
  if (template.configHash.toLowerCase() !== TEMPLATE_HASH.toLowerCase()) throw new Error("Template Config #6 hash changed; refusing to derive");
  if (!template.enabled) throw new Error("Template Config #6 is disabled");
  return template;
}

/** OrbitPad economics: template #6 fees/vesting/LP ratios, 0.01 WETH threshold, partner = platform wallet. */
export function orbitpadConfig(template: AmmoraV4ConfigSnapshot): { config: AmmoraV4Config; segments: readonly AmmoraV4Segment[] } {
  const saleSupply = SALE_TOKENS * 10n ** BigInt(template.config.tokenDecimals);
  const derived = deriveConfigFromTemplate(template, saleSupply, THRESHOLD_RAW);
  return {
    config: {
      ...derived.config,
      partnerRecipient: PARTNER,
      leftoverReceiver: PARTNER,
      liquidityDistribution: { ...derived.config.liquidityDistribution, partner: PARTNER },
    },
    segments: derived.curve,
  };
}

/** Creates the reusable OrbitPad platform Config, signed by the connected wallet (its owner). */
export async function createPlatformConfig(log: Log): Promise<bigint> {
  const { account } = await requireWallet();
  if (account.toLowerCase() !== PARTNER.toLowerCase()) {
    throw new Error(`Connect the OrbitPad platform wallet ${PARTNER} to create the platform Config`);
  }
  const block = await latestBlock();
  const { config, segments } = orbitpadConfig(await templateAt(block.number));
  log("Planning platform Config (threshold 0.01 WETH)…");
  const plan = await planCreateAmmoraV4Config(publicClient, core.configRegistry, config, segments, account, account);
  const receipt = await sendTx(plan.transaction, "Create Config", log);
  const created = parseAmmoraV4ConfigCreatedReceipt(receipt, core.configRegistry);
  rememberConfigId(created.configId);
  log(`Config #${created.configId} created.`);
  return created.configId;
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

const Q64 = 1n << 64n;

/** Fee-free exact-input estimate along one curve segment set, starting at its lower bound. */
function estimateBaseOut(segments: readonly AmmoraV4Segment[], quoteIn: bigint): bigint {
  let remaining = quoteIn;
  let out = 0n;
  for (const seg of segments) {
    if (remaining <= 0n) break;
    const maxQuote = seg.liquidity * (seg.upperSqrtPrice - seg.lowerSqrtPrice) / Q64;
    const used = remaining < maxQuote ? remaining : maxQuote;
    const next = seg.lowerSqrtPrice + used * Q64 / seg.liquidity;
    out += seg.liquidity * Q64 * (next - seg.lowerSqrtPrice) / (seg.lowerSqrtPrice * next);
    remaining -= used;
  }
  return out;
}

export async function createLaunch(input: LaunchInput, log: Log): Promise<{ token: Address; curve: Address }> {
  const { account } = await requireWallet();
  const uri = metadataUri(input);
  if (input.firstBuyRaw > 0n) return createWithFirstBuy(account, input, uri, log);

  const configId = platformConfigId();
  if (configId === null) throw new Error("No OrbitPad platform Config yet. Create it first (see the panel below), or add a first buy.");
  const block = await latestBlock();
  const snapshot = await getAmmoraV4ConfigAtBlock(publicClient, core.configRegistry, configId, block.number);
  if (!snapshot.enabled) throw new Error(`Config #${configId} is disabled`);
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

/** Atomic path: approval (if needed) → replan at a fresh block → READY → one Config+token+first-buy transaction. */
async function createWithFirstBuy(account: Address, input: LaunchInput, uri: string, log: Log) {
  if (input.firstBuyRaw >= THRESHOLD_RAW) throw new Error("First buy must be below the 0.01 WETH graduation threshold");
  const wethBalance = await publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  if (wethBalance < input.firstBuyRaw) throw new Error("Not enough WETH. Use “Wrap ETH → WETH” first.");

  const plan = async () => {
    const block = await latestBlock();
    const template = await templateAt(block.number);
    const { config, segments } = orbitpadConfig(template);
    const feeBps = BigInt(config.cliffFeeBps);
    const estimate = estimateBaseOut(segments, input.firstBuyRaw * (10_000n - feeBps) / 10_000n);
    const minimum = estimate * BigInt(10_000 - input.slippageBps) / 10_000n;
    if (minimum <= 0n) throw new Error("First buy too small to receive tokens");
    const fees = await publicClient.estimateFeesPerGas();
    return createConfigAndPoolWithFirstBuy(publicClient, {
      account,
      config,
      segments,
      launch: { name: input.name, symbol: input.symbol, metadataURI: uri, creatorMetadataURI: uri, tokenDecimals: config.tokenDecimals },
      firstBuys: [{ includedQuoteAmountRaw: input.firstBuyRaw, minimumBaseAmountOutRaw: minimum, allowPartialFill: false, recipient: account }],
      deadline: block.timestamp + 1800n,
      gas: { maxFeePerGasNativeRaw: (fees.maxFeePerGas ?? 1_000_000_000n) * 2n, safetyMarginBps: 2_000n },
      blockNumber: block.number,
    });
  };

  log("Previewing atomic Config + launch + first buy…");
  let result = await plan();
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

export async function recentLaunches(limit = 24): Promise<{ rows: LaunchRow[]; source: "api" | "rpc"; apiStatus?: Record<string, LaunchStatus> }> {
  try {
    const api = new AmmoraDataApiClient(DATA_API);
    const page = await api.getLaunches({ chainId: BigInt(giwaSepolia.id), signal: AbortSignal.timeout(6000) });
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
    return { rows: await launchesFromLogs(limit), source: "rpc" };
  }
}

const launchCreatedEvent = ammoraLaunchFactoryV4Abi.find(
  (item): item is Extract<(typeof ammoraLaunchFactoryV4Abi)[number], { type: "event"; name: "LaunchCreated" }> =>
    item.type === "event" && item.name === "LaunchCreated",
)!;

/** Fallback: scan LaunchCreated on the V4 factory backwards in fixed windows. */
export async function launchesFromLogs(limit: number, windows = 12, span = 10_000n): Promise<LaunchRow[]> {
  const head = await publicClient.getBlockNumber();
  const rows: LaunchRow[] = [];
  let to = head;
  for (let i = 0; i < windows && rows.length < limit && to > deploymentStart; i++) {
    const from = to - span + 1n > deploymentStart ? to - span + 1n : deploymentStart;
    const logs = await publicClient.getLogs({ address: core.launchFactory, event: launchCreatedEvent, fromBlock: from, toBlock: to });
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
  const head = await publicClient.getBlockNumber();
  const ranges: Array<[bigint, bigint]> = [];
  if (creationHint) ranges.push([creationHint, creationHint]);
  for (let to = head, i = 0; i < 30 && to > deploymentStart; i++) {
    const from = to - 9_999n > deploymentStart ? to - 9_999n : deploymentStart;
    ranges.push([from, to]);
    to = from - 1n;
  }
  for (const [fromBlock, toBlock] of ranges) {
    const logs = await publicClient.getLogs({ address: core.launchFactory, event: launchCreatedEvent, args: { curve }, fromBlock, toBlock });
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

export async function readCurve(curve: Address): Promise<CurveView> {
  const client = curveClient(curve);
  const blockNumber = await publicClient.getBlockNumber();
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

/** Lightweight list status: state + token symbol. */
export async function readRowState(curve: Address): Promise<{ state: AmmoraV4LaunchCurveState; name: string; symbol: string }> {
  const state = await curveClient(curve).getState();
  const [name, symbol] = await Promise.all([
    publicClient.readContract({ address: state.baseToken, abi: erc20Abi, functionName: "name" }),
    publicClient.readContract({ address: state.baseToken, abi: erc20Abi, functionName: "symbol" }),
  ]);
  return { state, name, symbol };
}

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
  const blockNumber = await publicClient.getBlockNumber();
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
    const blockNumber = await publicClient.getBlockNumber();
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
  const blockNumber = await publicClient.getBlockNumber();
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

// ---------- Fee split / claims ----------

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

/** Human-readable Creator/Partner economics from a Config (template #6 defaults for OrbitPad). */
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

export async function templateSplit(): Promise<Array<[string, string]>> {
  const blockNumber = await publicClient.getBlockNumber();
  return feeSplit((await templateAt(blockNumber)).config);
}

async function factoryFeeVault(): Promise<Address> {
  return publicClient.readContract({ address: core.launchFactory, abi: ammoraLaunchFactoryV4Abi, functionName: "feeVault" }) as Promise<Address>;
}

export type Claimable = { vault: Address; quote: bigint; base: bigint };

/** Fees accrued to `beneficiary` in the launch FeeVault (quote is shared across all of their launches). */
export async function claimableFees(state: AmmoraV4LaunchCurveState, beneficiary: Address): Promise<Claimable> {
  const vault = await factoryFeeVault();
  if (vault.toLowerCase() !== state.feeVault.toLowerCase()) throw new Error("Curve fee vault does not match the factory fee vault");
  const read = (token: Address) =>
    publicClient.readContract({ address: vault, abi: feeVaultAbi, functionName: "claimable", args: [token, beneficiary] }) as Promise<bigint>;
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

/** Points along the curve: x = WETH raised, y = price. */
export function curvePoints(segments: readonly AmmoraV4Segment[], baseDecimals: number, samples = 64) {
  const points: Array<{ x: number; y: number }> = [];
  let raised = 0;
  for (const seg of segments) {
    for (let i = 0; i <= samples; i++) {
      const s = seg.lowerSqrtPrice + (seg.upperSqrtPrice - seg.lowerSqrtPrice) * BigInt(i) / BigInt(samples);
      const quote = Number(seg.liquidity * (s - seg.lowerSqrtPrice) / Q64) / 1e18;
      points.push({ x: raised + quote, y: priceFromSqrt(s, baseDecimals) });
    }
    raised += Number(seg.liquidity * (seg.upperSqrtPrice - seg.lowerSqrtPrice) / Q64) / 1e18;
  }
  return points;
}

export function raisedAt(segments: readonly AmmoraV4Segment[], sqrtPrice: bigint): number {
  let raised = 0;
  for (const seg of segments) {
    const upper = sqrtPrice < seg.upperSqrtPrice ? sqrtPrice : seg.upperSqrtPrice;
    if (upper > seg.lowerSqrtPrice) raised += Number(seg.liquidity * (upper - seg.lowerSqrtPrice) / Q64) / 1e18;
  }
  return raised;
}

export const tokenBalance = async (token: Address, owner: Address) =>
  publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

