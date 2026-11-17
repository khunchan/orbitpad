import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  defineChain,
  erc20Abi,
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
export const RPC_URL = "https://sepolia-rpc.giwa.io";
export const EXPLORER = "https://sepolia-explorer.giwa.io";
export const WETH: Address = "0x4200000000000000000000000000000000000006";
export const DATA_API = "https://ammora-giwa-sepolia-data.fly.dev";

export const giwaSepolia = defineChain({
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: EXPLORER } },
  testnet: true,
});

if (deployment.chain.id !== giwaSepolia.id || launch.protocolVersion !== 4) {
  throw new Error("OrbitPad requires the GIWA Sepolia V4 auto-route deployment");
}

export const publicClient = createPublicClient({ chain: giwaSepolia, transport: http(RPC_URL, { batch: true }) });

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
    await client.addChain({ chain: giwaSepolia });
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

export type Tx = { to: Address; data: Hex; value?: bigint };

/** Simulates against the latest state, asks the wallet to sign, then waits for a successful receipt. */
export async function sendTx(tx: Tx, label: string, log: (msg: string) => void): Promise<TransactionReceipt> {
  const { client, account } = await requireWallet();
  log(`${label}: simulating…`);
  await publicClient.call({ account, to: tx.to, data: tx.data, value: tx.value });
  log(`${label}: confirm in your wallet…`);
  const hash = await client.sendTransaction({ account, chain: giwaSepolia, to: tx.to, data: tx.data, value: tx.value });
  log(`${label}: submitted ${short(hash)}, waiting for receipt…`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  log(`${label}: confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

export async function allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
}

export async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
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
