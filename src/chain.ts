import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatUnits,
  defineChain,
  erc20Abi,
  fallback,
  http,
  type Address,
  type EIP1193Provider,
  type Hex,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { giwaSepoliaAutoRouteDeployment } from "@ammora-protocol/sdk";

export const deployment = giwaSepoliaAutoRouteDeployment;
export const launch = deployment.contracts.launch;
/** GIWA's official public RPC: left to the wallet (it shares a per-IP rate limit with this page). */
export const RPC_URL = "https://sepolia-rpc.giwa.io";
const FLASHBLOCKS_RPC_URL = "https://sepolia-rpc-flashblocks.giwa.io";
const POCKET_RPC_URL = "https://giwa-sepolia-testnet.api.pocket.network";
/** Site reads: Pocket first, then GIWA Flashblocks, and the official RPC only as a last resort. */
export const SITE_RPC_URLS = [POCKET_RPC_URL, FLASHBLOCKS_RPC_URL, RPC_URL] as const;
export const EXPLORER = "https://sepolia-explorer.giwa.io";
export const WETH: Address = "0x4200000000000000000000000000000000000006";
export const DATA_API = "https://ammora-giwa-sepolia-data.fly.dev";

export const giwaSepolia = defineChain({
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [...SITE_RPC_URLS] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: EXPLORER } },
  testnet: true,
});

/** Network definition handed to the wallet (wallet_addEthereumChain): official RPC first, not the site's main RPC. */
const giwaSepoliaForWallet = defineChain({ ...giwaSepolia, rpcUrls: { default: { http: [RPC_URL, FLASHBLOCKS_RPC_URL] } } });

if (deployment.chain.id !== giwaSepolia.id || launch.protocolVersion !== 4) {
  throw new Error("OrbitPad requires the GIWA Sepolia V4 auto-route deployment");
}

/** At most MAX_INFLIGHT HTTP requests at once across all RPCs, so list pages don't trip public rate limits. */
const MAX_INFLIGHT = 4;
let inflight = 0;
const waiting: Array<() => void> = [];
const limitedFetch: typeof fetch = async (input, init) => {
  if (inflight >= MAX_INFLIGHT) await new Promise<void>(resolve => waiting.push(resolve));
  inflight++;
  try {
    return await fetch(input, init);
  } finally {
    inflight--;
    waiting.shift()?.();
  }
};

// viem retries with exponential backoff: delay = 2^attempt × retryDelay (here 400 ms, 800 ms, 1.6 s).
// Pocket gets no JSON-RPC batches: it answers a one-item batch with a bare object (unparseable as a batch,
// so every read burned all retries before falling back) and rejects larger batches with HTTP 413.
// It also has no retries: unbatched, it hits its own rate limit (429) under list load, and backing off on
// it only delays the fallback to GIWA's RPCs, which then take the request at once.
const rpc = (url: string) => http(url, {
  batch: url === POCKET_RPC_URL ? false : { batchSize: 10, wait: 16 },
  retryCount: url === POCKET_RPC_URL ? 0 : 3,
  retryDelay: 400,
  timeout: 15_000,
  fetchFn: limitedFetch,
});

export const publicClient = createPublicClient({
  chain: giwaSepolia,
  transport: fallback(SITE_RPC_URLS.map(rpc), { retryCount: 1, retryDelay: 500 }),
});

/**
 * Event-log queries go to GIWA's own RPCs only: Pocket's eth_getLogs randomly omits events (the same
 * 10k-block window returned 3 LaunchCreated logs on GIWA RPC and 0 on Pocket), so launches went missing.
 */
export const logsClient = createPublicClient({
  chain: giwaSepolia,
  transport: fallback([FLASHBLOCKS_RPC_URL, RPC_URL].map(rpc), { retryCount: 1, retryDelay: 500 }),
});

export const core = {
  configRegistry: launch.configRegistry,
  launchFactory: launch.factory,
  graduationAdapter: launch.graduationAdapter,
  feePolicy: launch.feePolicy,
} as const;

export const wethAbi = [
  ...erc20Abi,
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

type Listener = () => void;
const listeners = new Set<Listener>();
export const onWalletChange = (fn: Listener) => listeners.add(fn);
const emit = () => listeners.forEach(fn => fn());

export const wallet: { account: Address | null; chainId: number | null; client: WalletClient | null } = {
  account: null,
  chainId: null,
  client: null,
};

const provider = (): EIP1193Provider | undefined => (window as unknown as { ethereum?: EIP1193Provider }).ethereum;

export const hasWallet = () => Boolean(provider());

export async function connect(): Promise<void> {
  const eth = provider();
  if (!eth) throw new Error("No browser wallet found. Install Rabby or another EIP-1193 wallet.");
  const client = createWalletClient({ chain: giwaSepolia, transport: custom(eth) });
  const [account] = await client.requestAddresses();
  wallet.client = client;
  wallet.account = account ?? null;
  wallet.chainId = await client.getChainId();
  if (wallet.chainId !== giwaSepolia.id) await switchNetwork();
  emit();
}

export async function switchNetwork(): Promise<void> {
  const client = wallet.client;
  if (!client) return;
  try {
    await client.switchChain({ id: giwaSepolia.id });
  } catch (error) {
    const code = (error as { code?: number; cause?: { code?: number } }).code ?? (error as { cause?: { code?: number } }).cause?.code;
    if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String((error as Error).message))) throw error;
    await client.addChain({ chain: giwaSepoliaForWallet });
    await client.switchChain({ id: giwaSepolia.id });
  }
  wallet.chainId = await client.getChainId();
  emit();
}

export function watchProvider(): void {
  const eth = provider();
  if (!eth?.on) return;
  eth.on("accountsChanged", (accounts: readonly Address[]) => {
    wallet.account = accounts[0] ?? null;
    emit();
  });
  eth.on("chainChanged", (id: string) => {
    wallet.chainId = Number(id);
    emit();
  });
}

/** Silently restores a previously authorised connection without prompting. */
export async function restore(): Promise<void> {
  const eth = provider();
  if (!eth) return;
  const accounts = (await eth.request({ method: "eth_accounts" })) as Address[];
  if (!accounts.length) return;
  wallet.client = createWalletClient({ chain: giwaSepolia, transport: custom(eth) });
  wallet.account = accounts[0] ?? null;
  wallet.chainId = await wallet.client.getChainId();
  emit();
}

export async function requireWallet(): Promise<{ client: WalletClient; account: Address }> {
  if (!wallet.client || !wallet.account) await connect();
  if (wallet.chainId !== giwaSepolia.id) await switchNetwork();
  if (!wallet.client || !wallet.account) throw new Error("Wallet not connected");
  if (wallet.chainId !== giwaSepolia.id) throw new Error("Switch your wallet to GIWA Sepolia");
  return { client: wallet.client, account: wallet.account };
}

// ---------- Background gate ----------

let walletPrompts = 0;
const resumeWaiters: Array<() => void> = [];
const resumeBackground = () => {
  if (walletPrompts === 0 && !document.hidden) resumeWaiters.splice(0).forEach(resolve => resolve());
};
if (typeof document !== "undefined") document.addEventListener("visibilitychange", resumeBackground);

/**
 * Background work (list loading, live quotes, balance panels, post-tx re-render) waits here while a
 * wallet confirmation is open or the tab is hidden, so the page doesn't eat the wallet's RPC limit.
 */
export async function backgroundGate(): Promise<void> {
  while (walletPrompts > 0 || (typeof document !== "undefined" && document.hidden)) {
    await new Promise<void>(resolve => resumeWaiters.push(resolve));
  }
}

/** Rejects with `message` if `promise` hasn't settled after `ms`; the underlying work is abandoned, not cancelled. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Marks a wallet interaction (simulate → sign → receipt); background reads pause until it ends. */
export async function withWalletPrompt<T>(fn: () => Promise<T>): Promise<T> {
  walletPrompts++;
  try {
    return await fn();
  } catch (error) {
    throw friendlyWalletError(error);
  } finally {
    walletPrompts--;
    resumeBackground();
  }
}

const RATE_LIMIT = /rate.?limit|over rate|too many requests|429|-32005|limit exceeded|request limit/i;
/** Maps a wallet-side RPC throttle to an actionable message; other errors pass through unchanged. */
export function friendlyWalletError(error: unknown): unknown {
  for (let e = error as { message?: string; details?: string; code?: number; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === -32005 || e.code === 429 || RATE_LIMIT.test(`${e.message ?? ""} ${e.details ?? ""}`)) {
      return new Error("Wallet RPC is rate-limited, wait a few seconds and try again", { cause: error });
    }
  }
  return error;
}

// ---------- Read-after-write consistency ----------

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Highest block of a confirmed transaction of ours; reads must not be served from an older block. */
let minReadBlock = 0n;

/** Latest block number, waiting (with backoff) until the RPC has caught up with our last receipt. */
export async function freshBlockNumber(): Promise<bigint> {
  for (let attempt = 0; ; attempt++) {
    const head = await publicClient.getBlockNumber({ cacheTime: 0 });
    if (head >= minReadBlock) return head;
    if (attempt >= 12) throw new Error(`RPC is still behind block ${minReadBlock}; retry in a moment`);
    await sleep(Math.min(4_000, 300 * 2 ** attempt));
  }
}

const isLagError = (error: unknown) =>
  /header not found|unknown block|block not found|missing trie|not available|RPC Request failed|timed out/i.test(String((error as Error)?.message ?? error));

/** Runs a read pinned to `block` (default: a fresh block), retrying while the RPC lags behind it. */
export async function readAt<T>(fn: (block: bigint) => Promise<T>, block?: bigint): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(block ?? (await freshBlockNumber()));
    } catch (error) {
      if (attempt >= 5 || !isLagError(error)) throw error;
      await sleep(400 * 2 ** attempt);
    }
  }
}

type WatchedToken = { address: Address; symbol: string; decimals: number };
const watched = new Map<string, WatchedToken>();
/** Tokens whose balance change is reported after each transaction (WETH is always included). */
export function watchToken(address: Address, symbol: string, decimals: number) {
  watched.set(address.toLowerCase(), { address, symbol, decimals });
}

export type TxConfirmed = { receipt: TransactionReceipt; label: string };
const txListeners = new Set<(event: TxConfirmed) => void>();
export const onTxConfirmed = (fn: (event: TxConfirmed) => void) => txListeners.add(fn);

const formatDelta = (raw: bigint, decimals: number) => {
  const text = formatUnits(raw < 0n ? -raw : raw, decimals);
  const [whole, frac = ""] = text.split(".");
  const trimmed = frac.slice(0, 8).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : (raw !== 0n && whole === "0" ? `<0.00000001` : whole!);
};

/**
 * After a confirmed transaction: pin future reads to its block, log the exact balance changes of the
 * account (block N-1 → N, read at the receipt block with retries), then notify the UI to refresh.
 */
export async function afterConfirmed(receipt: TransactionReceipt, label: string, log: (msg: string) => void): Promise<void> {
  if (receipt.blockNumber > minReadBlock) minReadBlock = receipt.blockNumber;
  const account = wallet.account;
  if (account) {
    try {
      const before = receipt.blockNumber - 1n;
      const tokens = [{ address: WETH, symbol: "WETH", decimals: 18 }, ...[...watched.values()].filter(t => t.address.toLowerCase() !== WETH.toLowerCase())];
      const deltas = await Promise.all(tokens.map(async t => {
        const read = (blockNumber: bigint) => publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber });
        // A token created by this very transaction has no code at N-1: its prior balance is zero.
        const a = await readAt(read, before).catch(error => {
          if (/returned no data|0x"\)/.test(String((error as Error).message))) return 0n;
          throw error;
        });
        const b = await readAt(read, receipt.blockNumber);
        return { t, delta: b - a };
      }));
      const ethDelta = await Promise.all([before, receipt.blockNumber].map(blockNumber =>
        readAt(n => publicClient.getBalance({ address: account, blockNumber: n }), blockNumber)));
      for (const { t, delta } of deltas) {
        if (delta > 0n) log(`+${formatDelta(delta, t.decimals)} ${t.symbol} received`);
        else if (delta < 0n) log(`−${formatDelta(delta, t.decimals)} ${t.symbol} spent`);
      }
      const eth = ethDelta[1]! - ethDelta[0]!;
      if (eth !== 0n) log(`${eth > 0n ? "+" : "−"}${formatDelta(eth, 18)} ETH (incl. gas)`);
    } catch (error) {
      log(`Balance check skipped: ${String((error as Error).message ?? error).split("\n")[0]}`);
    }
  }
  txListeners.forEach(fn => fn({ receipt, label }));
}

export type Tx = { to: Address; data: Hex; value?: bigint };

/** Simulates against the latest state, asks the wallet to sign, then waits for a successful receipt. */
export async function sendTx(tx: Tx, label: string, log: (msg: string) => void): Promise<TransactionReceipt> {
  const receipt = await withWalletPrompt(() => signAndWait(tx, label, log));
  await afterConfirmed(receipt, label, log);
  return receipt;
}

async function signAndWait(tx: Tx, label: string, log: (msg: string) => void): Promise<TransactionReceipt> {
  const { client, account } = await requireWallet();
  log(`${label}: simulating…`);
  await withTimeout(publicClient.call({ account, to: tx.to, data: tx.data, value: tx.value }), 60_000,
    `${label}: simulation got no answer from the network RPC in 60 s. Nothing was sent; try again.`);
  log(`${label}: confirm in your wallet…`);
  const hash = await client.sendTransaction({ account, chain: giwaSepolia, to: tx.to, data: tx.data, value: tx.value });
  log(`${label}: submitted ${short(hash)}, waiting for receipt…`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 }).catch(error => {
    if ((error as Error)?.name !== "WaitForTransactionReceiptTimeoutError") throw error;
    throw new Error(`${label}: no receipt after 3 min. It may still confirm: check ${EXPLORER}/tx/${hash} before retrying.`);
  });
  if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  log(`${label}: confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

export async function allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return readAt(blockNumber => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender], blockNumber }));
}

export async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  return readAt(blockNumber => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber }));
}

export async function nativeBalance(owner: Address): Promise<bigint> {
  return readAt(blockNumber => publicClient.getBalance({ address: owner, blockNumber }));
}

/** Approves exactly `amount` (resetting a stale non-zero allowance to 0 first). */
export async function ensureExactAllowance(token: Address, spender: Address, amount: bigint, log: (msg: string) => void): Promise<void> {
  const { account } = await requireWallet();
  const current = await allowance(token, account, spender);
  if (current === amount) return;
  const approve = (value: bigint): Tx => ({
    to: token,
    data: encodeApprove(spender, value),
  });
  if (current > 0n) await sendTx(approve(0n), "Reset allowance", log);
  await sendTx(approve(amount), "Approve exact amount", log);
}

/** Revokes any leftover allowance after a trade (e.g. unused input at the graduation boundary). */
export async function revokeLeftover(token: Address, spender: Address, log: (msg: string) => void): Promise<void> {
  const { account } = await requireWallet();
  if ((await allowance(token, account, spender)) > 0n) {
    await sendTx({ to: token, data: encodeApprove(spender, 0n) }, "Revoke leftover allowance", log);
  }
}

const encodeApprove = (spender: Address, value: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, value] });

export const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`;
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
