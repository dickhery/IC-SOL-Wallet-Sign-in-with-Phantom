// src/sol_icp_poc_frontend/assets/main.js
import { Actor, HttpAgent } from "https://cdn.jsdelivr.net/npm/@dfinity/agent@3.1.0/+esm";
import { AuthClient } from "https://cdn.jsdelivr.net/npm/@dfinity/auth-client@3.1.0/+esm";
import idlFactory from "./sol_icp_poc_backend.idl.js";

async function loadCanisterConfig() {
  const search = new URLSearchParams(window.location.search);
  const hostname = window.location.hostname;
  const inferredNetwork =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")
      ? "local"
      : "ic";

  const network =
    (globalThis.dfxNetwork ?? globalThis.DFX_NETWORK ?? search.get("network") ?? inferredNetwork) ||
    "ic";

  let canisterId =
    globalThis.CANISTER_ID_SOL_ICP_POC_BACKEND ??
    search.get("canisterId") ??
    null;

  if (!canisterId) {
    try {
      const response = await fetch("./canister_ids.json", { cache: "no-cache" });
      if (response.ok) {
        const data = await response.json();
        const entry = data?.sol_icp_poc_backend ?? {};
        canisterId = entry[network] ?? entry.ic ?? Object.values(entry)[0] ?? null;
      }
    } catch (err) {
      console.warn("Unable to load canister_ids.json; falling back to embedded canister ID.", err);
    }
  }

  if (!canisterId) {
    console.warn("No canister ID resolved dynamically; using mainnet fallback.");
    canisterId = "f4kcz-fqaaa-aaaap-an3hq-cai";
  }

  const host = network === "ic" ? "https://ic0.app" : "http://localhost:4943";
  return { host, canisterId, network };
}

const { host, canisterId, network } = await loadCanisterConfig();

let authClient = null;
let identity = null;
let agent = null;
let actor = null;

let authMode = null; // "ii" | "phantom"
let solPubkey = null;
let lastKnownSolBalance = { lamports: null, fetchedAt: 0 };

// ---- UI helpers ----
function setVisible(id, visible) {
  document.getElementById(id).style.display = visible ? "block" : "none";
}
function uiSet(id, value) {
  document.getElementById(id).innerText = value;
}
function alertSet(cls, msg) {
  const el = document.getElementById("alerts");
  el.className = cls;
  el.textContent = msg || "";
}
const showOk = (m) => alertSet("ok", m);
const showWarn = (m) => alertSet("warn", m);
const showErr = (m) => alertSet("err", m);
const showMuted = (m) => alertSet("muted", m);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatSolAmount = (lamports) => `${(Number(lamports) / 1e9).toFixed(9)}`;

const RETRIABLE_SOL_PATTERNS = [
  /timed out/i,
  /processing/i,
  /consensus/i,
  /inconsistent/i,
  /temporar/i,
  /retry/i,
  /429/, // rate limits
  /limit/i,
  /network/i,
  /rpc/i,
  /getbalance/i,
  /blockhash/i,
];

function shouldRetrySol(msg, err) {
  const haystacks = [msg, err?.message, err ? String(err) : ""].filter(Boolean);
  return haystacks.some((text) =>
    RETRIABLE_SOL_PATTERNS.some((pattern) => pattern.test(String(text)))
  );
}

function normalizeAgentError(e) {
  const s = (e?.message || String(e || "")).trim();
  if (/Request timed out after/i.test(s)) {
    return "Request timed out. This may be due to network delays or consensus issues. The operation may still succeed—refresh balances in a few seconds.";
  }
  if (/processing/i.test(s) && /Request ID:/i.test(s)) {
    return "The network is processing the call. Refresh balances shortly.";
  }
  if (/inconsistent/i.test(s) || /consensus/i.test(s)) {
    return "Network variance prevented consensus. Retry the operation.";
  }
  if (/blockhash/i.test(s)) {
    return "Blockhash retrieval failed; network may be busy. Retry.";
  }
  return s;
}

function friendlyTry(fn, onErr) {
  return fn().catch((e) => {
    console.error('Error in operation:', e, e.stack);
    const msg = normalizeAgentError(e);
    if (onErr) onErr(msg, e);
    else showErr(msg);
    throw e;
  });
}

// Add timeout wrapper for calls
async function withTimeout(promise, ms = 300000) {  // Increased to 5min to handle slow outcalls
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function makeAgentAndActor() {
  agent = new HttpAgent({ host, identity: identity ?? undefined });
  if (network !== "ic") {
    await agent.fetchRootKey();
  }
  actor = Actor.createActor(idlFactory, { agent, canisterId });
}

async function initAuthIfNeeded() {
  if (!authClient) authClient = await AuthClient.create();
}

// ---- Phantom provider ----
function getProvider() {
  if ("phantom" in window) {
    const provider = window.phantom?.solana;
    if (provider?.isPhantom) return provider;
  }
  window.open("https://phantom.app/", "_blank");
}
const provider = getProvider();

// ---- fees & constants ----
const serviceFeeICP = 0.0001;         // ICP fee for ICP transfers
const serviceFeeSolICP = 0.0002;      // ICP fee for SOL ops
const icpLedgerFee = 0.0001;          // ICP ledger fee to move service fee
const networkFeeICP = 0.0002;         // two ledger ops in ICP send
const solanaFeeApprox = 0.000005;     // SOL fee approx
const serviceFeeE8s = BigInt(Math.round(serviceFeeICP * 1e8));
const serviceFeeSolE8s = BigInt(Math.round(serviceFeeSolICP * 1e8));

// ---- Throttle state for refreshes ----
let lastSolRefreshMs = 0;
let solRefreshInFlight = false;
let lastIcpRefreshMs = 0;
let icpRefreshInFlight = false;
const COOLDOWN_MS = 10_000;

// Shared refresh that respects auth mode + cooldowns
async function refreshSolBalance(force = false) {
  const now = Date.now();
  if (!force && (now - lastSolRefreshMs) < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastSolRefreshMs)) / 1000);
    showWarn(`Please wait ~${wait}s before refreshing SOL again.`);
    return;
  }
  if (solRefreshInFlight) {
    showMuted("Refreshing SOL…");
    return;
  }
  if (!authMode) {
    showWarn("Pick an auth mode to refresh SOL.");
    return;
  }
  if (authMode === "phantom" && !solPubkey) {
    showWarn("Connect Phantom first");
    return;
  }

  showMuted("Fetching SOL balance... this may take up to 1 minute due to network consensus.");
  uiSet("sol_balance", "SOL Balance: Loading...");

  solRefreshInFlight = true;
  const button = document.getElementById("get_sol");
  if (button) { button.disabled = true; }

  let lamports = null;
  let lastError = "";
  const maxRetries = 5;
  const retryIntervalMs = 5000;

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        let res;
        if (authMode === "ii") {
          res = await withTimeout(actor.get_sol_balance_ii());
        } else {
          res = await withTimeout(actor.get_sol_balance(solPubkey));
        }
        if ('Err' in res) {
          throw new Error(res.Err);
        }
        lamports = res.Ok;
        lastSolRefreshMs = Date.now();
        showMuted("SOL balance updated.");
        break;
      } catch (err) {
        console.error('Refresh SOL error:', err, err.stack);
        const friendly = normalizeAgentError(err);
        lastError = friendly;
        const attemptsLeft = maxRetries - attempt;
        if (attemptsLeft > 0 && shouldRetrySol(friendly, err)) {
          const waitMs = retryIntervalMs * attempt;
          showWarn(`SOL refresh issue (${attempt}/${maxRetries}): ${friendly}. Retrying in ${(waitMs/1000).toFixed(0)}s...`);
          await sleep(waitMs);
          continue;
        }
        showErr(friendly);
        break;
      }
    }
  } finally {
    solRefreshInFlight = false;
    if (button) { button.disabled = false; }
  }

  const currentTime = Date.now();
  if (lamports !== null && lamports !== undefined) {
    lastKnownSolBalance = { lamports, fetchedAt: currentTime };
    uiSet("sol_balance", `SOL Balance: ${formatSolAmount(lamports)} SOL`);
    return;
  }

  if (lastKnownSolBalance.lamports !== null) {
    const ageSeconds = Math.max(0, Math.round((currentTime - lastKnownSolBalance.fetchedAt) / 1000));
    const staleInfo = ageSeconds > 0 ? ` (stale; last updated ${ageSeconds}s ago)` : " (stale)";
    uiSet("sol_balance", `SOL Balance: ${formatSolAmount(lastKnownSolBalance.lamports)} SOL${staleInfo}`);
    if (lastError) {
      showWarn(`${lastError} — showing last known SOL balance.`);
    }
    return;
  }

  uiSet("sol_balance", "SOL Balance: unavailable");
  if (lastError) {
    showErr(lastError);
  } else {
    showErr("Unable to fetch SOL balance.");
  }
}

async function refreshIcpBalance(force = false) {
  showMuted("Fetching ICP balance... this may take up to 1 minute due to network consensus.");
  uiSet("balance", "ICP Balance: Loading...");
  const now = Date.now();
  if (!force && (now - lastIcpRefreshMs) < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastIcpRefreshMs)) / 1000);
    showWarn(`Please wait ~${wait}s before refreshing ICP again.`);
    return;
  }
  if (icpRefreshInFlight) {
    showMuted("Refreshing ICP…");
    return;
  }
  icpRefreshInFlight = true;
  const button = document.getElementById("refresh_icp");
  if (button) { button.disabled = true; }

  let e8s = 0n;  // BigInt for nat64
  let hadError = false;
  let attempts = 0;
  const maxRetries = 3;
  const retryInterval = 10000;  // 10s between retries

  while (attempts < maxRetries) {
    attempts++;
    try {
      let res;
      if (authMode === "ii") {
        res = await withTimeout(friendlyTry(() => actor.get_balance_ii(), (m) => showWarn(m)));
      } else if (authMode === "phantom") {
        if (!solPubkey) return showWarn("Connect Phantom first");
        res = await withTimeout(friendlyTry(() => actor.get_balance(solPubkey), (m) => showWarn(m)));
      } else {
        showWarn("Pick an auth mode to refresh ICP.");
        return;
      }
      if ('Err' in res) {
        throw new Error(res.Err);
      }
      e8s = res.Ok;
      showMuted("ICP balance updated.");
      lastIcpRefreshMs = Date.now();
      break;  // Success, exit loop
    } catch (e) {
      hadError = true;
      console.error('Refresh ICP error:', e, e.stack);
      const msg = normalizeAgentError(e);
      if (msg.includes("Timed out") && attempts < maxRetries) {
        showWarn(`ICP refresh timed out (attempt ${attempts}/${maxRetries}). Retrying in 10s...`);
        await new Promise(resolve => setTimeout(resolve, retryInterval));
        continue;  // Retry
      } else {
        showErr(msg);
        break;
      }
    }
  }
  icpRefreshInFlight = false;
  if (button) { button.disabled = false; }
  let balanceText = `ICP Balance: ${(Number(e8s)/1e8).toFixed(8)} ICP`;
  if (hadError) balanceText += " (fetch failed after retries)";
  uiSet("balance", balanceText);
}

async function refreshBothBalances(force = false) {
  await Promise.allSettled([
    refreshIcpBalance(force),
    refreshSolBalance(force),
  ]);
}

// Clear all dynamic text/inputs except latest-tx
function clearAllExceptTx() {
  ["ii_status", "status", "pid", "pubkey"].forEach(id => uiSet(id, ""));
  uiSet("deposit", "ICP Deposit Address: Not loaded (connect/login first)");
  uiSet("balance", "ICP Balance: Not loaded (connect/login first)");
  uiSet("sol_deposit", "SOL Deposit Address: Not loaded (connect/login first)");
  uiSet("sol_balance", "SOL Balance: Not loaded (connect/login first)");
  ["to", "amount", "to_sol", "amount_sol"].forEach(id => document.getElementById(id).value = "");
  lastKnownSolBalance = { lamports: null, fetchedAt: 0 };
}

// ---- refresh buttons ----
document.getElementById("get_sol").onclick = async () => {
  await refreshSolBalance(false);
};

document.getElementById("refresh_icp").onclick = async () => {
  await refreshIcpBalance(false);
};

// ---- Auth mode switching ----
function enterIiUi() {
  setVisible("ii_block", true);
  setVisible("phantom_block", false);
  uiSet("mode_status", "Mode: Internet Identity");
  alertSet("", "");
}
function enterPhantomUi() {
  setVisible("phantom_block", true);
  setVisible("ii_block", false);
  uiSet("mode_status", "Mode: Phantom");
  alertSet("", "");
}

document.getElementById("mode_ii").onclick = async () => {
  clearAllExceptTx();
  if (authMode === "phantom") {
    try { await provider.disconnect(); } catch {}
    solPubkey = null;
  }
  authMode = "ii";
  await initAuthIfNeeded();
  await makeAgentAndActor();
  enterIiUi();
};

document.getElementById("mode_phantom").onclick = async () => {
  clearAllExceptTx();
  if (authMode === "ii") {
    if (!authClient) await initAuthIfNeeded();
    try { await authClient.logout(); } catch {}
    identity = null;
  }
  authMode = "phantom";
  await makeAgentAndActor();
  enterPhantomUi();
};

// ---- II login/logout ----
document.getElementById("ii_login").onclick = async () => {
  if (authMode !== "ii") return alert("Switch to Internet Identity mode first");
  await initAuthIfNeeded();
  const opts = { identityProvider: "https://id.ai" };
  authClient.login({
    ...opts,
    maxTimeToLive: BigInt(7) * BigInt(24*60*60*1_000_000_000),
    onSuccess: async () => {
      identity = authClient.getIdentity();
      await makeAgentAndActor();
      try {
        const prin = await actor.whoami();
        uiSet("ii_status", `Signed in as: ${prin}`);

        uiSet("deposit", "ICP Deposit Address: Loading...");
        const depRes = await withTimeout(friendlyTry(async () => {
          const r = await actor.get_deposit_address_ii();
          if ('Err' in r) throw new Error(r.Err);
          return r.Ok;
        }, (m) => showWarn(m)));
        uiSet("deposit", `ICP Deposit to: ${depRes} (Send ICP here)`);

        uiSet("sol_deposit", "SOL Deposit Address: Loading...");
        const solDepRes = await withTimeout(friendlyTry(async () => {
          const r = await actor.get_sol_deposit_address_ii();
          if ('Err' in r) throw new Error(r.Err);
          return r.Ok;
        }, (m) => showWarn(m)));
        uiSet("sol_deposit", `SOL Deposit to: ${solDepRes} (Mainnet; send SOL here)`);

        uiSet("pid", `ICP Principal: ${prin}`);

        await refreshBothBalances(true);
        showOk("Logged in with Internet Identity.");
      } catch (e) {
        uiSet("ii_status", `Signed in (fetch error).`);
        showWarn(normalizeAgentError(e));
      }
    },
    onError: (err) => {
      showErr(`II login failed: ${normalizeAgentError(err)}`);
    }
  });
};

document.getElementById("ii_logout").onclick = async () => {
  await initAuthIfNeeded();
  await authClient.logout();
  identity = null;
  await makeAgentAndActor();
  uiSet("ii_status", "Not signed in");
  uiSet("pid", "");
  showMuted("Logged out of Internet Identity.");
};

// ---- Phantom connect/logout ----
document.getElementById("connect").onclick = async () => {
  if (authMode !== "phantom") return alert("Switch to Phantom mode first");
  try {
    const resp = await provider.connect();
    solPubkey = resp.publicKey.toString();
    uiSet("pubkey", `Sol Pubkey: ${solPubkey} (Solana Mainnet)`);

    uiSet("deposit", "ICP Deposit Address: Loading...");
    const deposit = await friendlyTry(() => actor.get_deposit_address(solPubkey), (m) => showWarn(m));
    uiSet("deposit", `ICP Deposit to: ${deposit} (Send ICP here)`);

    uiSet("sol_deposit", "SOL Deposit Address: Loading...");
    const solDepositRes = await withTimeout(friendlyTry(async () => {
      const r = await actor.get_sol_deposit_address(solPubkey);
      if ('Err' in r) throw new Error(r.Err);
      return r.Ok;
    }, (m) => showWarn(m)));
    uiSet("sol_deposit", `SOL Deposit to: ${solDepositRes} (Mainnet; send SOL here)`);

    await refreshBothBalances(true);
    showOk("Connected to Phantom.");
  } catch (err) {
    showErr(`Phantom connect error: ${normalizeAgentError(err)}`);
  }
};

document.getElementById("logout").onclick = async () => {
  try { await provider.disconnect(); } catch {}
  solPubkey = null;
  ["pubkey","pid","deposit","balance","sol_deposit","sol_balance"].forEach(id => uiSet(id, ""));
  showMuted("Disconnected Phantom. To prevent auto-reconnect, revoke in Phantom settings.");
};

// ---- ICP send ----
let sendingIcp = false;
document.getElementById("send").onclick = async () => {
  showMuted("Processing ICP transfer... this may take up to 2 minutes due to network consensus.");
  if (sendingIcp) return showWarn("ICP send already in progress.");
  sendingIcp = true;
  const button = document.getElementById("send");
  button.disabled = true; button.innerText = 'Processing... (may take 2min)';

  let initialNonce;
  try {
    const to = document.getElementById("to").value;
    const amountICP = document.getElementById("amount").value;
    if (isNaN(parseFloat(amountICP)) || parseFloat(amountICP) < 0) {
      throw new Error("Invalid amount");
    }
    const amount = BigInt(Math.round(parseFloat(amountICP) * 1e8));

    if (authMode === "ii") {
      const nonceRes = await actor.get_nonce_ii();
      if ('Err' in nonceRes) throw new Error(nonceRes.Err);
      initialNonce = nonceRes.Ok;

      const totalICP = parseFloat(amountICP) + networkFeeICP + serviceFeeICP;
      const confirmMsg = `Confirm transaction (II mode):\nTo: ${to}\nAmount: ${amountICP} ICP\nNetwork fee: ${networkFeeICP} ICP\nService fee: ${serviceFeeICP} ICP\nTotal deduction: ${totalICP.toFixed(8)} ICP`;
      if (!window.confirm(confirmMsg)) throw new Error("Cancelled");

      const result = await withTimeout(friendlyTry(() => actor.transfer_ii(to, amount), (m) => showWarn(m)));
      displayResult(result);
      if (result.startsWith("Transfer successful")) {
        await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15s for finalization
        await refreshBothBalances(true);
        document.getElementById("to").value = '';
        document.getElementById("amount").value = '';
        showOk("ICP transfer complete. Balances updated.");
      } else {
        showWarn(result);
      }
      return;
    }

    if (authMode === "phantom") {
      if (!solPubkey) throw new Error("Connect Phantom first");

      const nonceRes = await actor.get_nonce(solPubkey);
      if ('Err' in nonceRes) throw new Error(nonceRes.Err);
      initialNonce = nonceRes.Ok;

      const amountICPNum = parseFloat(amountICP);
      const totalICP = amountICPNum + networkFeeICP + serviceFeeICP;
      const confirmMsg = `Confirm transaction (Phantom mode):\nTo: ${to}\nAmount: ${amountICP} ICP\nNetwork fee: ${networkFeeICP} ICP\nService fee: ${serviceFeeICP} ICP\nTotal deduction: ${totalICP.toFixed(8)} ICP`;
      if (!window.confirm(confirmMsg)) throw new Error("Cancelled");

      const message = `transfer to ${to} amount ${amount} nonce ${initialNonce} service_fee ${serviceFeeE8s}`;
      const encodedMessage = new TextEncoder().encode(message);
      const signed = await provider.signMessage(encodedMessage, "utf8");
      const signature = signed.signature;

      const result = await withTimeout(friendlyTry(() => actor.transfer(to, amount, solPubkey, Array.from(signature), initialNonce), (m) => showWarn(m)));
      displayResult(result);
      if (result.startsWith("Transfer successful")) {
        await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15s for finalization
        await refreshBothBalances(true);
        document.getElementById("to").value = '';
        document.getElementById("amount").value = '';
        showOk("ICP transfer complete. Balances updated.");
      } else {
        showWarn(result);
      }
    }
  } catch (err) {
    console.error('ICP send error:', err, err.stack);
    const msg = (err?.message || String(err || "")).toLowerCase();
    if (msg.includes("timed out") || msg.includes("processing")) {
      await confirmAfterTimeout(initialNonce, "ICP");
    } else if (err.message === "Cancelled") {
      // user cancelled
    } else {
      showErr(`ICP send error: ${normalizeAgentError(err)}`);
    }
  } finally {
    sendingIcp = false;
    button.disabled = false; button.innerText = 'Send ICP';
  }
};

// ---- SOL read/send ----
let sendingSol = false;
document.getElementById("send_sol").onclick = async () => {
  showMuted("Processing SOL transfer... this may take up to 2 minutes due to network consensus.");
  if (sendingSol) return showWarn("SOL send already in progress.");
  sendingSol = true;
  const button = document.getElementById("send_sol");
  button.disabled = true; button.innerText = 'Processing... (may take 2min)';

  let initialNonce;
  try {
    const to_sol = document.getElementById("to_sol").value;
    const amountSOL = document.getElementById("amount_sol").value;
    if (isNaN(parseFloat(amountSOL)) || parseFloat(amountSOL) < 0) {
      throw new Error("Invalid amount");
    }
    const amountLam = BigInt(Math.round(parseFloat(amountSOL) * 1e9));

    if (authMode === "ii") {
      const nonceRes = await actor.get_nonce_ii();
      if ('Err' in nonceRes) throw new Error(nonceRes.Err);
      initialNonce = nonceRes.Ok;
      const totalSOL = parseFloat(amountSOL) + solanaFeeApprox;
      const totalIcpForSol = serviceFeeSolICP + icpLedgerFee;
      const confirmMsg = `Confirm SOL transaction (II mode):\nTo: ${to_sol}\nAmount: ${amountSOL} SOL\nSolana fee: ~${solanaFeeApprox} SOL\nICP ledger fee: ${icpLedgerFee} ICP\nService fee: ${serviceFeeSolICP} ICP\nTotal SOL deduction: ${totalSOL.toFixed(9)} SOL\nTotal ICP deduction: ${totalIcpForSol.toFixed(4)} ICP`;
      if (!window.confirm(confirmMsg)) throw new Error("Cancelled");

      const result = await withTimeout(friendlyTry(() => actor.transfer_sol_ii(to_sol, amountLam), (m) => showWarn(m)));
      displayResult(result);
      if (result.startsWith("Transfer successful")) {
        await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15s for finalization
        await refreshBothBalances(true);
        document.getElementById("to_sol").value = '';
        document.getElementById("amount_sol").value = '';
        showOk("SOL transfer complete. Balances updated.");
      } else {
        showWarn(result);
      }
      return;
    }

    if (authMode === "phantom") {
      if (!solPubkey) throw new Error("Connect first");
      const nonceRes = await actor.get_nonce(solPubkey);
      if ('Err' in nonceRes) throw new Error(nonceRes.Err);
      initialNonce = nonceRes.Ok;

      const amountSOLNum = parseFloat(amountSOL);
      const totalSOL = amountSOLNum + solanaFeeApprox;
      const totalIcpForSol = serviceFeeSolICP + icpLedgerFee;
      const confirmMsg = `Confirm SOL transaction (Phantom mode):\nTo: ${to_sol}\nAmount: ${amountSOL} SOL\nSolana fee: ~${solanaFeeApprox} SOL\nICP ledger fee: ${icpLedgerFee} ICP\nService fee: ${serviceFeeSolICP} ICP\nTotal SOL deduction: ${totalSOL.toFixed(9)} SOL\nTotal ICP deduction: ${totalIcpForSol.toFixed(4)} ICP`;
      if (!window.confirm(confirmMsg)) throw new Error("Cancelled");

      const message = `transfer_sol to ${to_sol} amount ${amountLam} nonce ${initialNonce} service_fee ${serviceFeeSolE8s}`;
      const encodedMessage = new TextEncoder().encode(message);
      const signed = await provider.signMessage(encodedMessage, "utf8");
      const signature = signed.signature;

      const result = await withTimeout(friendlyTry(() => actor.transfer_sol(to_sol, amountLam, solPubkey, Array.from(signature), initialNonce), (m) => showWarn(m)));
      displayResult(result);
      if (result.startsWith("Transfer successful")) {
        await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15s for finalization
        await refreshBothBalances(true);
        document.getElementById("to_sol").value = '';
        document.getElementById("amount_sol").value = '';
        showOk("SOL transfer complete. Balances updated.");
      } else {
        showWarn(result);
      }
    }
  } catch (err) {
    console.error('SOL send error:', err, err.stack);
    const msg = (err?.message || String(err || "")).toLowerCase();
    if (msg.includes("timed out") || msg.includes("processing")) {
      await confirmAfterTimeout(initialNonce, "SOL");
    } else if (err.message === "Cancelled") {
      // noop
    } else {
      showErr(`SOL send error: ${normalizeAgentError(err)}`);
    }
  } finally {
    sendingSol = false;
    button.disabled = false; button.innerText = 'Send SOL';
  }
};

// Polling function for nonce change (to confirm TX success after timeout)
async function pollNonceForChange(initialNonce, maxAttempts = 10, intervalMs = 15000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    try {
      let nonceRes;
      if (authMode === "ii") {
        nonceRes = await actor.get_nonce_ii();
      } else {
        nonceRes = await actor.get_nonce(solPubkey);
      }
      if ('Err' in nonceRes) continue;
      const currentNonce = nonceRes.Ok;
      if (currentNonce > initialNonce) {
        return true; // success
      }
    } catch {}
    showMuted(`Polling for confirmation (${attempt}/${maxAttempts})...`);
  }
  return false;
}

// Helper for timeout/processing -> confirm via nonce
async function confirmAfterTimeout(initialNonce, assetType = "ICP") {
  showMuted(`${assetType} send submitted, waiting for network confirmation...`);
  const success = await pollNonceForChange(initialNonce, 12, 10000);
  if (success) {
    displayResult("Transfer successful (confirmed via nonce change)");
    await refreshBothBalances(true);
    showOk(`${assetType} transfer complete (delayed confirmation). Balances updated.`);
  } else {
    showWarn(`${assetType} send timed out and no confirmation detected. Check explorer or retry.`);
  }
}

// Safer result classification
function displayResult(res) {
  const txDiv = document.getElementById('latest-tx');
  let html = res;
  let cls = 'muted';

  const lower = res.toLowerCase();
  const isSuccess = res.startsWith('Transfer successful');
  const isHardFail = res.startsWith('Transfer failed') || res.startsWith('Send failed');
  const isErrorish = !isSuccess && /error/.test(lower);

  if (isSuccess) {
    cls = 'ok';
    const blockMatch = res.match(/block (\d+)/);
    if (blockMatch) {
      const block = blockMatch[1];
      const link = `https://dashboard.internetcomputer.org/`;
      html += ` <a href="${link}" target="_blank">View on ICP Dashboard</a>`;
    }
    const txidMatch = res.match(/txid (\S+)/);
    if (txidMatch) {
      const txid = txidMatch[1];
      const link = `https://explorer.solana.com/tx/${txid}`;
      html += ` <a href="${link}" target="_blank">View on Solana Explorer</a>`;
    }
  } else if (isHardFail) {
    cls = 'err';
  } else if (isErrorish) {
    cls = 'warn';
  }

  txDiv.className = cls;
  txDiv.innerHTML = html;
}

// ---- Boot ----
await makeAgentAndActor();
uiSet("mode_status", "Pick a mode: Internet Identity or Phantom");
showMuted("Ready.");
document.getElementById("latest-tx").innerHTML = "No transactions yet.";
clearAllExceptTx();  // Set initial placeholders

// ---- Copy buttons ----
document.getElementById("copy_icp").onclick = async () => {
  const depositEl = document.getElementById("deposit");
  const depositText = depositEl.innerText.trim();
  if (!depositText.startsWith("ICP Deposit to: ")) {
    showWarn("No ICP address loaded yet.");
    return;
  }
  const address = depositText.split("ICP Deposit to: ")[1].trim().split(' ')[0];
  try {
    await navigator.clipboard.writeText(address);
    const button = document.getElementById("copy_icp");
    button.innerText = "Copied!";
    setTimeout(() => { button.innerText = "Copy ICP Addr"; }, 2000);
    showOk("ICP address copied to clipboard.");
  } catch (err) {
    showErr(`Failed to copy ICP address: ${normalizeAgentError(err)}`);
  }
};

document.getElementById("copy_sol").onclick = async () => {
  const solDepositEl = document.getElementById("sol_deposit");
  const solDepositText = solDepositEl.innerText.trim();
  if (!solDepositText.startsWith("SOL Deposit to: ")) {
    showWarn("No SOL address loaded yet.");
    return;
  }
  const address = solDepositText.split("SOL Deposit to: ")[1].trim().split(' ')[0];
  try {
    await navigator.clipboard.writeText(address);
    const button = document.getElementById("copy_sol");
    button.innerText = "Copied!";
    setTimeout(() => { button.innerText = "Copy SOL Addr"; }, 2000);
    showOk("SOL address copied to clipboard.");
  } catch (err) {
    showErr(`Failed to copy SOL address: ${normalizeAgentError(err)}`);
  }
};

