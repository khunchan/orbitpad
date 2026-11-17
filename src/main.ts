import "./style.css";
import { isAddress, parseEther, parseUnits, getAddress, type Address } from "viem";
import {
  addressUrl,
  connect,
  giwaSepolia,
  hasWallet,
  onWalletChange,
  publicClient,
  restore,
  short,
  switchNetwork,
  wallet,
  watchProvider,
  WETH,
} from "./chain";
import {
  PARTNER,
  THRESHOLD_RAW,
  createLaunch,
  createPlatformConfig,
  curvePoints,
  executeTrade,
  findLaunch,
  fmt,
  migrate,
  parseMetadata,
  platformConfigId,
  previewTrade,
  priceFromSqrt,
  raisedAt,
  readCurve,
  readRowState,
  recentLaunches,
  statusLabel,
  progressOf,
  tokenBalance,
  wrapEth,
  type CurveView,
  type LaunchStatus,
} from "./ammora";
import { pixelAvatar } from "./pixel";

const app = document.getElementById("app")!;

const esc = (value: unknown) =>
  String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const statusClass = (s: LaunchStatus) =>
  s === "Trading" ? "trading" : s === "Ready to migrate" ? "ready" : s === "Graduated" ? "graduated" : "pending";
const statusPill = (s: LaunchStatus) => `<span class="status ${statusClass(s)}">${esc(s)}</span>`;
const progressBar = (bps: number) => `<div class="progress" title="${(bps / 100).toFixed(1)}%"><div style="width:${Math.max(0, Math.min(100, bps / 100))}%"></div></div>`;

function errorMessage(error: unknown): string {
  const e = error as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(error)).split("\n")[0]!;
}

function logger(el: HTMLElement) {
  el.innerHTML = "";
  el.classList.add("show");
  return {
    log: (msg: string) => {
      const line = document.createElement("div");
      line.textContent = `› ${msg}`;
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
    },
    error: (error: unknown) => {
      const line = document.createElement("div");
      line.className = "err";
      line.textContent = `✕ ${errorMessage(error)}`;
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
    },
  };
}

// ---------- Shell ----------

function shell() {
  app.innerHTML = `
  <header class="top"><div class="wrap">
    <a class="brand" href="#/"><div class="orb"></div><span>OrbitPad</span></a>
    <nav class="links">
      <a href="#/" data-route="home">Launches</a>
      <a href="#/launch" data-route="launch">Launch</a>
    </nav>
    <div class="spacer"></div>
    <button class="icon" id="theme" title="Toggle theme" aria-label="Toggle theme">◐</button>
    <button id="connect" class="primary">Connect</button>
  </div></header>
  <main><div class="wrap" id="view"></div></main>
  <footer class="foot"><div class="wrap">
    <div>Built with the Ammora SDK. Not an official Ammora site. Testnet only, pre-audit — do not use real funds.</div>
    <div class="links">
      <a href="https://faucet.giwa.io/" target="_blank" rel="noopener">GIWA faucet</a>
      <a href="https://docs.ammora.org/guides/launchpad" target="_blank" rel="noopener">Builder guide</a>
      <a href="https://github.com/khunchan/orbitpad" target="_blank" rel="noopener">Source</a>
    </div>
  </div></footer>`;
  document.getElementById("theme")!.addEventListener("click", toggleTheme);
  document.getElementById("connect")!.addEventListener("click", async () => {
    try {
      if (wallet.account && wallet.chainId !== giwaSepolia.id) await switchNetwork();
      else await connect();
    } catch (error) {
      alert(errorMessage(error));
    }
  });
  renderWalletButton();
}

function toggleTheme() {
  const root = document.documentElement;
  const current = root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem("orbitpad-theme", next); } catch { /* ignore */ }
}

function renderWalletButton() {
  const btn = document.getElementById("connect");
  if (!btn) return;
  if (!hasWallet()) btn.textContent = "No wallet";
  else if (!wallet.account) btn.textContent = "Connect";
  else if (wallet.chainId !== giwaSepolia.id) btn.textContent = "Switch to GIWA";
  else btn.textContent = short(wallet.account);
}

// ---------- Routing ----------

let routeToken = 0;
function route() {
  routeToken++;
  const hash = location.hash.replace(/^#/, "") || "/";
  const view = document.getElementById("view")!;
  document.querySelectorAll<HTMLAnchorElement>("nav.links a").forEach(a => {
    a.classList.toggle("active", (a.dataset.route === "launch" && hash === "/launch") || (a.dataset.route === "home" && hash === "/"));
  });
  const tokenMatch = hash.match(/^\/t\/(0x[0-9a-fA-F]{40})$/);
  if (hash === "/launch") renderLaunch(view);
  else if (tokenMatch && isAddress(tokenMatch[1]!)) renderToken(view, getAddress(tokenMatch[1]!), routeToken);
  else renderHome(view, routeToken);
  window.scrollTo(0, 0);
}

// ---------- Home ----------

async function renderHome(view: HTMLElement, token: number) {
  view.innerHTML = `
    <section class="hero">
      <span class="badge-testnet">GIWA Sepolia testnet</span>
      <h1>Launch tokens into <span class="grad-text">orbit</span>.</h1>
      <p>Create a token on an Ammora bonding curve, trade it, and graduate it to a pool once it raises 0.01 WETH — every transaction signed in your own wallet.</p>
      <div class="inline" style="margin-top:18px"><a class="btn primary" href="#/launch" style="color:#fff;background:var(--grad);border:0">Launch a token</a></div>
    </section>
    <div class="section-head"><h2>Recent launches</h2><span class="muted small" id="src"></span></div>
    <div class="grid launches" id="list">${Array.from({ length: 6 }, () => `<div class="card"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="margin-top:12px"></div></div>`).join("")}</div>`;
  const list = view.querySelector<HTMLElement>("#list")!;
  try {
    const { rows, source, apiStatus } = await recentLaunches(24);
    if (token !== routeToken) return;
    view.querySelector("#src")!.textContent = source === "api" ? "via Ammora Data API" : "via on-chain LaunchCreated events";
    if (!rows.length) {
      list.innerHTML = `<div class="card muted">No launches found yet. Be the first — <a href="#/launch">launch a token</a>.</div>`;
      return;
    }
    list.innerHTML = rows.map(r => `
      <a class="card launch-card" href="#/t/${r.curve}" data-curve="${r.curve}">
        <div class="row1">${pixelAvatar(r.token, 44)}
          <div style="min-width:0;flex:1"><div class="name" data-f="name">${esc(short(r.token))}</div>
          <div class="muted small" data-f="sym">Config #${r.configId}</div></div>
          <span data-f="status">${statusPill(apiStatus?.[r.curve.toLowerCase()] ?? "Pending")}</span>
        </div>
        <div data-f="bar">${progressBar(0)}</div>
        <div class="muted small" data-f="pct">Loading curve…</div>
      </a>`).join("");
    // Fill in on-chain status/progress progressively, a few at a time.
    const queue = [...rows];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        if (token !== routeToken) return;
        const card = list.querySelector<HTMLElement>(`[data-curve="${r.curve}"]`);
        if (!card) continue;
        try {
          const { state, name, symbol } = await readRowState(r.curve);
          const bps = progressOf(state);
          card.querySelector("[data-f=name]")!.textContent = name;
          card.querySelector("[data-f=sym]")!.textContent = `$${symbol}`;
          card.querySelector("[data-f=status]")!.innerHTML = statusPill(statusLabel(state.status));
          card.querySelector("[data-f=bar]")!.innerHTML = progressBar(bps);
          card.querySelector("[data-f=pct]")!.textContent =
            `${(bps / 100).toFixed(1)}% to graduation · ${fmt(state.quoteReserve, 18, 5)} / ${fmt(state.migrationQuoteThreshold, 18, 5)} WETH`;
        } catch {
          card.querySelector("[data-f=pct]")!.textContent = "Not an OrbitPad-readable curve";
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  } catch (error) {
    if (token !== routeToken) return;
    list.innerHTML = `<div class="card"><div class="notice warn">Could not load launches: ${esc(errorMessage(error))}</div></div>`;
  }
}

// ---------- Launch ----------

function renderLaunch(view: HTMLElement) {
  const configId = platformConfigId();
  view.innerHTML = `
    <div class="section-head" style="margin-top:0"><h2>Launch a token</h2></div>
    <div class="grid two">
      <form class="card" id="launch-form" autocomplete="off">
        <div class="field"><label for="name">Name</label><input id="name" maxlength="40" required placeholder="Orbit Cat" /></div>
        <div class="field"><label for="ticker">Ticker</label><input id="ticker" maxlength="10" required placeholder="OCAT" style="text-transform:uppercase" /></div>
        <div class="field"><label for="desc">Description</label><textarea id="desc" maxlength="280" placeholder="What is this token about?"></textarea></div>
        <div class="field"><label for="first">First buy (WETH, optional)</label>
          <input id="first" inputmode="decimal" placeholder="0.002" />
          <span class="muted small">With a first buy, a new OrbitPad Config, your token and the first buy are created atomically in one transaction (after an exact WETH approval). Must be below 0.01 WETH.</span>
        </div>
        <div class="field"><label for="slip">Slippage for first buy (%)</label><input id="slip" inputmode="decimal" value="5" /></div>
        <button class="primary" type="submit" style="width:100%">Launch</button>
        <div class="log" id="launch-log"></div>
      </form>
      <div class="grid">
        <div class="card">
          <h3>How it works</h3>
          <dl class="kv">
            <dt>Network</dt><dd>GIWA Sepolia (91342)</dd>
            <dt>Quote asset</dt><dd>WETH</dd>
            <dt>Graduation at</dt><dd>${fmt(THRESHOLD_RAW, 18)} WETH</dd>
            <dt>Sale supply</dt><dd>100,000,000 tokens</dd>
            <dt>Platform Config</dt><dd>${configId === null ? "not created yet" : `#${configId}`}</dd>
          </dl>
        </div>
        <div class="card">
          <h3>Wrap ETH → WETH</h3>
          <p class="muted small" style="margin-top:0">Trades use WETH. ETH pays gas. Get testnet ETH from the <a href="https://faucet.giwa.io/" target="_blank" rel="noopener">GIWA faucet</a>.</p>
          <div class="inline"><input id="wrap-amt" inputmode="decimal" value="0.02" /><button id="wrap">Wrap</button></div>
          <div class="muted small" id="bal" style="margin-top:8px"></div>
          <div class="log" id="wrap-log"></div>
        </div>
        <div class="card">
          <h3>Platform Config</h3>
          <p class="muted small" style="margin-top:0">Launches without a first buy use OrbitPad's shared Config: template #6 fees, 0.01 WETH threshold, partner fees to <code>${short(PARTNER)}</code>. Create it once from the partner wallet.</p>
          <button id="mkconfig" ${configId === null ? "" : "disabled"}>${configId === null ? "Create platform Config" : `Config #${configId} active`}</button>
          <div class="log" id="config-log"></div>
        </div>
      </div>
    </div>`;

  const showBalances = async () => {
    const el = view.querySelector("#bal");
    if (!el || !wallet.account) return;
    const [eth, weth] = await Promise.all([publicClient.getBalance({ address: wallet.account }), tokenBalance(WETH, wallet.account)]);
    el.textContent = `Balance: ${fmt(eth, 18, 5)} ETH · ${fmt(weth, 18, 5)} WETH`;
  };
  showBalances().catch(() => {});

  view.querySelector("#wrap")!.addEventListener("click", async e => {
    const btn = e.currentTarget as HTMLButtonElement;
    const out = logger(view.querySelector("#wrap-log")!);
    btn.disabled = true;
    try {
      await wrapEth(parseEther((view.querySelector<HTMLInputElement>("#wrap-amt")!.value || "0").trim()), out.log);
      await showBalances();
    } catch (error) { out.error(error); } finally { btn.disabled = false; }
  });

  view.querySelector("#mkconfig")!.addEventListener("click", async e => {
    const btn = e.currentTarget as HTMLButtonElement;
    const out = logger(view.querySelector("#config-log")!);
    btn.disabled = true;
    try {
      const id = await createPlatformConfig(out.log);
      btn.textContent = `Config #${id} active`;
      out.log(`Saved locally. Share this ID with the OrbitPad maintainers to make it the site default.`);
    } catch (error) { out.error(error); btn.disabled = false; }
  });

  view.querySelector<HTMLFormElement>("#launch-form")!.addEventListener("submit", async e => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    const out = logger(view.querySelector("#launch-log")!);
    const name = form.querySelector<HTMLInputElement>("#name")!.value.trim();
    const symbol = form.querySelector<HTMLInputElement>("#ticker")!.value.trim().toUpperCase();
    const description = form.querySelector<HTMLTextAreaElement>("#desc")!.value.trim();
    const firstRaw = form.querySelector<HTMLInputElement>("#first")!.value.trim();
    const slip = Number(form.querySelector<HTMLInputElement>("#slip")!.value || "5");
    if (!name || !symbol) return out.error("Name and ticker are required");
    if (!/^[A-Z0-9]{1,10}$/.test(symbol)) return out.error("Ticker: 1–10 letters or digits");
    if (!(slip > 0 && slip < 50)) return out.error("Slippage must be between 0 and 50%");
    btn.disabled = true;
    try {
      const firstBuyRaw = firstRaw ? parseUnits(firstRaw, 18) : 0n;
      const created = await createLaunch({ name, symbol, description, firstBuyRaw, slippageBps: Math.round(slip * 100) }, out.log);
      out.log(`Token ${created.token} on curve ${created.curve}. Opening…`);
      setTimeout(() => (location.hash = `#/t/${created.curve}`), 900);
    } catch (error) {
      out.error(error);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- Token ----------

function chartSvg(view: CurveView): string {
  const pts = curvePoints(view.segments, view.baseDecimals);
  if (!pts.length) return "";
  const W = 560, H = 260, L = 56, R = 14, T = 14, B = 34;
  const maxX = Math.max(...pts.map(p => p.x)) || 1;
  const maxY = Math.max(...pts.map(p => p.y)) || 1;
  const sx = (x: number) => L + (x / maxX) * (W - L - R);
  const sy = (y: number) => H - B - (y / maxY) * (H - T - B);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const area = `${line} L${sx(maxX).toFixed(1)},${H - B} L${L},${H - B} Z`;
  const cx = Math.min(raisedAt(view.segments, view.state.sqrtPrice), maxX);
  const cy = priceFromSqrt(view.state.sqrtPrice, view.baseDecimals);
  const done = pts.filter(p => p.x <= cx);
  const doneArea = done.length > 1
    ? `${done.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ")} L${sx(cx).toFixed(1)},${sy(cy).toFixed(1)} L${sx(cx).toFixed(1)},${H - B} L${L},${H - B} Z`
    : "";
  const fy = (v: number) => (v === 0 ? "0" : v < 1e-6 ? v.toExponential(1) : v.toPrecision(2));
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bonding curve: price against WETH raised">
    <defs><linearGradient id="cg" x1="0" x2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#14d8c4"/></linearGradient>
    <linearGradient id="ca" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7c5cff" stop-opacity=".35"/><stop offset="1" stop-color="#14d8c4" stop-opacity=".05"/></linearGradient></defs>
    <line class="axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/><line class="axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"/>
    <path d="${area}" fill="var(--card-2)"/>
    ${doneArea ? `<path d="${doneArea}" fill="url(#ca)"/>` : ""}
    <path d="${line}" fill="none" stroke="url(#cg)" stroke-width="2.5" stroke-linejoin="round"/>
    <line x1="${sx(cx)}" y1="${T}" x2="${sx(cx)}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="3 4" opacity=".6"/>
    <circle cx="${sx(cx)}" cy="${sy(cy)}" r="6" fill="var(--card)" stroke="#7c5cff" stroke-width="3"/>
    <text class="lbl" x="${L}" y="${H - 12}">0</text>
    <text class="lbl" x="${W - R}" y="${H - 12}" text-anchor="end">${maxX.toFixed(4)} WETH raised</text>
    <text class="lbl" x="${L - 6}" y="${T + 8}" text-anchor="end">${fy(maxY)}</text>
    <text class="lbl" x="${L - 6}" y="${H - B}" text-anchor="end">0</text>
    <text class="lbl" x="${Math.min(sx(cx) + 10, W - 120)}" y="${Math.max(sy(cy) - 10, T + 10)}">now ${fy(cy)} WETH</text>
  </svg>`;
}

async function renderToken(view: HTMLElement, curve: Address, token: number) {
  view.innerHTML = `<div class="card"><div class="skeleton" style="width:40%"></div><div class="skeleton" style="margin-top:14px"></div><div class="skeleton" style="margin-top:14px;width:70%"></div></div>`;
  let data: CurveView;
  try {
    data = await readCurve(curve);
  } catch (error) {
    if (token !== routeToken) return;
    view.innerHTML = `<div class="card"><div class="notice warn">Could not read this curve: ${esc(errorMessage(error))}</div><p><a href="#/">← Back to launches</a></p></div>`;
    return;
  }
  if (token !== routeToken) return;
  const { state } = data;
  const status = statusLabel(state.status);
  const price = priceFromSqrt(state.sqrtPrice, data.baseDecimals);

  view.innerHTML = `
    <div class="token-head">
      ${pixelAvatar(state.baseToken, 64)}
      <div style="min-width:0;flex:1">
        <h1>${esc(data.name)} <span class="muted" style="font-weight:500">$${esc(data.symbol)}</span></h1>
        <div class="inline small muted">${statusPill(status)}
          <a href="${addressUrl(state.baseToken)}" target="_blank" rel="noopener" class="mono">token ${short(state.baseToken)}</a>
          <a href="${addressUrl(curve)}" target="_blank" rel="noopener" class="mono">curve ${short(curve)}</a>
        </div>
      </div>
    </div>
    <p class="muted" id="desc" style="margin-top:-6px"></p>
    <div class="grid two">
      <div class="grid">
        <div class="card">
          <div class="inline" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">Graduation progress</h2><strong>${(data.progressBps / 100).toFixed(1)}%</strong></div>
          ${progressBar(data.progressBps)}
          <p class="muted small" style="margin-bottom:0">${fmt(state.quoteReserve, 18, 6)} of ${fmt(state.migrationQuoteThreshold, 18, 6)} WETH raised on the curve.</p>
        </div>
        <div class="card chart"><h2>Bonding curve</h2>${chartSvg(data)}
          <p class="muted small" style="margin-bottom:0">Price (WETH per token) against WETH raised. The dot is the current price.</p></div>
        <div class="card"><h2>Curve state</h2><dl class="kv">
          <dt>Status</dt><dd>${esc(status)} (${state.status})</dd>
          <dt>Price</dt><dd>${price.toPrecision(4)} WETH</dd>
          <dt>Tokens left on curve</dt><dd>${fmt(state.baseReserve, data.baseDecimals, 2)}</dd>
          <dt>Current fee</dt><dd>${(state.currentFeeBps / 100).toFixed(2)}%</dd>
          <dt>Config</dt><dd>#${state.configId}</dd>
          <dt>Creator</dt><dd><a class="mono" href="${addressUrl(state.creator)}" target="_blank" rel="noopener">${short(state.creator)}</a></dd>
          <dt>As of block</dt><dd>${state.asOfBlock}</dd>
        </dl></div>
      </div>
      <div class="card" id="action"></div>
    </div>`;

  findLaunch(curve).then(row => {
    if (token !== routeToken || !row) return;
    const meta = parseMetadata(row.metadataURI);
    const el = view.querySelector("#desc");
    if (el && meta.description) el.textContent = meta.description;
  }).catch(() => {});

  const action = view.querySelector<HTMLElement>("#action")!;
  if (state.status === 3) {
    action.innerHTML = `<h2>Graduated 🎓</h2>
      <p class="muted">This token has migrated off the bonding curve into its canonical pool.</p>
      <dl class="kv"><dt>Pool</dt><dd><a class="mono" href="${addressUrl(state.canonicalPool)}" target="_blank" rel="noopener">${short(state.canonicalPool)}</a></dd></dl>`;
    return;
  }
  if (state.status === 2) {
    action.innerHTML = `<h2>Ready to migrate</h2>
      <p class="muted">The final buy filled the curve. Anyone can now run the permissionless migration into the graduated pool. Trading on the curve is closed.</p>
      <button class="primary" id="migrate" style="width:100%">Migrate</button>
      <div class="log" id="mig-log"></div>`;
    action.querySelector("#migrate")!.addEventListener("click", async e => {
      const btn = e.currentTarget as HTMLButtonElement;
      const out = logger(action.querySelector("#mig-log")!);
      btn.disabled = true;
      try {
        const pool = await migrate(curve, out.log);
        out.log(`Graduated. Pool ${pool}`);
        setTimeout(route, 1200);
      } catch (error) { out.error(error); btn.disabled = false; }
    });
    return;
  }
  if (state.status !== 1) {
    action.innerHTML = `<h2>Not trading yet</h2><p class="muted">Curve status ${state.status}.</p>`;
    return;
  }

  let side: "buy" | "sell" = "buy";
  action.innerHTML = `
    <div class="tabs"><button class="on" data-side="buy">Buy</button><button data-side="sell">Sell</button></div>
    <div class="field"><label id="amt-label" for="amt">You pay (WETH)</label><input id="amt" inputmode="decimal" placeholder="0.001" /></div>
    <div class="field"><label for="tslip">Slippage (%)</label><input id="tslip" inputmode="decimal" value="1" /></div>
    <div class="notice" id="quote">Enter an amount for a live quote.</div>
    <div class="muted small" id="tbal" style="margin:10px 0"></div>
    <button class="primary" id="trade" style="width:100%">Buy</button>
    <div class="log" id="trade-log"></div>`;
  const amt = action.querySelector<HTMLInputElement>("#amt")!;
  const slipInput = action.querySelector<HTMLInputElement>("#tslip")!;
  const quoteEl = action.querySelector<HTMLElement>("#quote")!;
  const tradeBtn = action.querySelector<HTMLButtonElement>("#trade")!;
  const inDecimals = () => (side === "buy" ? 18 : data.baseDecimals);
  const slippageBps = () => Math.round(Number(slipInput.value || "1") * 100);

  const showBal = async () => {
    if (!wallet.account) return;
    const [w, t] = await Promise.all([tokenBalance(WETH, wallet.account), tokenBalance(state.baseToken, wallet.account)]);
    action.querySelector("#tbal")!.textContent = `You hold ${fmt(w, 18, 5)} WETH · ${fmt(t, data.baseDecimals, 2)} ${data.symbol}`;
  };
  showBal().catch(() => {});

  let quoteSeq = 0;
  const refreshQuote = async () => {
    const seq = ++quoteSeq;
    const raw = amt.value.trim();
    if (!raw || Number(raw) <= 0) { quoteEl.className = "notice"; quoteEl.textContent = "Enter an amount for a live quote."; return; }
    try {
      const amountIn = parseUnits(raw, inDecimals());
      const q = await previewTrade(curve, side, amountIn, slippageBps());
      if (seq !== quoteSeq) return;
      const outDec = side === "buy" ? data.baseDecimals : 18;
      const outSym = side === "buy" ? data.symbol : "WETH";
      quoteEl.className = q.kind === "full" ? "notice" : "notice warn";
      const base = `≈ ${fmt(q.amountOut, outDec, 4)} ${esc(outSym)} · min ${fmt(q.minimumOut, outDec, 4)} after ${(slippageBps() / 100).toFixed(2)}% slippage`;
      quoteEl.innerHTML = q.kind === "full" ? base
        : q.kind === "graduation-boundary" ? `${base}<br><strong>Final buy:</strong> fills the curve. Uses ${fmt(q.consumed, 18)} WETH; ${fmt(q.refundable, 18)} WETH stays in your wallet. Then the token can be migrated.`
        : q.kind === "terminal-dust" ? "The curve's remaining output rounds to zero. Not executable."
        : "This amount cannot be filled in full. Try a smaller amount.";
      tradeBtn.disabled = q.kind === "terminal-dust" || q.kind === "partial";
    } catch (error) {
      if (seq !== quoteSeq) return;
      quoteEl.className = "notice warn";
      quoteEl.textContent = errorMessage(error);
    }
  };
  let timer: number | undefined;
  const debounced = () => { clearTimeout(timer); timer = window.setTimeout(refreshQuote, 350); };
  amt.addEventListener("input", debounced);
  slipInput.addEventListener("input", debounced);

  action.querySelectorAll<HTMLButtonElement>(".tabs button").forEach(b => b.addEventListener("click", () => {
    side = b.dataset.side as "buy" | "sell";
    action.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
    action.querySelector("#amt-label")!.textContent = side === "buy" ? "You pay (WETH)" : `You sell (${data.symbol})`;
    amt.placeholder = side === "buy" ? "0.001" : "100000";
    tradeBtn.textContent = side === "buy" ? "Buy" : "Sell";
    refreshQuote();
  }));

  tradeBtn.addEventListener("click", async () => {
    const out = logger(action.querySelector("#trade-log")!);
    const slip = slippageBps();
    if (!(slip > 0 && slip < 5000)) return out.error("Slippage must be between 0 and 50%");
    tradeBtn.disabled = true;
    try {
      const amountIn = parseUnits(amt.value.trim() || "0", inDecimals());
      if (amountIn <= 0n) throw new Error("Enter an amount");
      const swap = await executeTrade(curve, side, amountIn, slip, out.log);
      out.log(`Done: received ${fmt(swap.amountOut, side === "buy" ? data.baseDecimals : 18, 6)} ${side === "buy" ? data.symbol : "WETH"}.`);
      setTimeout(route, 1500);
    } catch (error) {
      out.error(error);
    } finally {
      tradeBtn.disabled = false;
    }
  });
}

// ---------- Boot ----------

shell();
onWalletChange(() => {
  renderWalletButton();
});
watchProvider();
restore().catch(() => {});
window.addEventListener("hashchange", route);
route();

