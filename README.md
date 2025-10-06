# IC-SOL Wallet: Seamless ICP-Solana Bridge on the Internet Computer

Welcome to **IC-SOL Wallet**, a groundbreaking proof-of-concept project that showcases the power of the Internet Computer (ICP) in bridging two major blockchain ecosystems: ICP and Solana. This innovative application allows users to securely hold, manage, and transfer both ICP tokens and SOL (Solana's native cryptocurrency) from a single, unified wallet interface—all powered by a Rust-based backend canister on ICP. By leveraging ICP's unique capabilities like threshold Schnorr signatures, HTTPS outcalls, and seamless integration with external wallets, this project demonstrates how ICP can act as a trustless intermediary for cross-chain operations, enabling unprecedented interoperability between ICP's scalable, low-cost smart contracts and Solana's high-speed blockchain.

What makes this app truly impressive? It empowers users to authenticate via either **Internet Identity** (ICP's native, privacy-focused authentication system) or **Phantom Wallet** (Solana's popular browser extension wallet), and then effortlessly interact with **both** ICP and SOL assets using the chosen method. No need for multiple wallets or complex bridging protocols—everything happens within a simple, static web interface that runs directly in your browser, even in environments like ICP Ninja. This not only simplifies user experience but also highlights ICP's role as a "world computer" capable of securely interfacing with external blockchains like Solana through consensus-driven HTTPS outcalls, ensuring deterministic and tamper-proof results across replicas.

Whether you're a developer exploring cross-chain dApps or a user looking for a hassle-free way to manage multi-chain assets, IC-SOL Wallet pushes the boundaries of what's possible in decentralized finance and blockchain interoperability.

## Features

- **Dual Authentication Support**: Authenticate with Internet Identity (for ICP-native security) or Phantom Wallet (for Solana users), and manage both ICP and SOL from either.
- **Cross-Chain Asset Management**: Deposit, view balances, and transfer ICP and SOL seamlessly. Transfers are secured via ICP's threshold signatures for Solana operations.
- **Service Fee Mechanism**: A minimal ICP-based service fee (currently 0.0003 ICP) covers cross-chain operations like SOL transfers, deducted transparently from your ICP balance.
- **Latency-Aware Design**: Built with ICP's HTTPS outcalls for querying Solana RPC endpoints, ensuring consensus across replicas—though this introduces some natural latency (typically 10-60 seconds for refreshes and transfers due to multi-replica consensus and network calls).
- **Static Frontend**: No build tools required; the UI loads as ES modules from a CDN, no bundler needed.
- **Error Resilience**: Most issues (e.g., balance refresh errors) resolve with a simple page refresh and re-login, thanks to the stateless nature of the frontend.
- **Secure and Transparent**: All operations are handled by an ICP canister using stable memory for user data, with nonce-based replay protection and signature verification.

## Technical Overview

At its core, IC-SOL Wallet is an ICP canister written in Rust that acts as a bridge between ICP's ledger and Solana's blockchain. Here's how it works under the hood:

### Backend (Rust Canister)
- **Authentication**:
  - **Internet Identity (II)**: Uses ICP's principal for authentication. The canister derives Solana public keys using ICP's threshold Schnorr (Ed25519) signatures via the management canister.
  - **Phantom Wallet**: Verifies Solana Ed25519 signatures on custom messages (e.g., "transfer_sol to [address] amount [lamports] nonce [nonce] service_fee [fee]") to authorize actions.
- **Asset Handling**:
  - **ICP**: Stored in subaccounts derived from the user's Solana public key or ICP principal. Transfers use the ICP ledger canister directly.
  - **SOL**: Managed via derived Solana accounts on ICP. Deposits are detected via Solana RPC queries; transfers are signed using ICP's threshold Schnorr and broadcast to Solana via HTTPS outcalls to RPC providers.
- **HTTPS Outcalls and Consensus**:
  - To interact with Solana, the canister makes HTTPS outcalls to multiple Solana RPC endpoints (e.g., via the SOL RPC canister at `tghme-zyaaa-aaaar-qarca-cai`). Each ICP replica independently queries Solana, and results are reconciled via ICP's consensus protocol to ensure determinism.
  - This introduces latency: Outcalls take ~2-5 seconds per replica, plus consensus rounds (up to 10-30 seconds total for operations like balance refreshes or transfers). Variable responses (e.g., recent blockhashes) are handled via transformations or durable nonces to achieve agreement.
- **Security Measures**:
  - Nonce system prevents replay attacks.
  - Service fees (0.0001 ICP for ICP transfers, 0.0002 ICP + ledger fee for SOL) are transferred to a service account before executing operations.
  - Stable memory (via `ic_stable_structures`) stores nonces and mappings.
- **Solana Integration**:
  - Uses Solana's System Program for transfers.
  - Fetches slots and blockhashes via outcalls, then constructs and signs transactions with ICP-derived keys.

### Frontend (Static JS)
- Built as pure ES modules: Loads DFINITY's agent libraries from CDN, no bundler needed.
- Dynamically resolves canister IDs based on network (local, ic) from `canister_ids.json`.
- UI handles auth switching, balance refreshes (with cooldowns to prevent spam), and transfers with confirmations.
- Error normalization for user-friendly messages (e.g., timeouts may indicate pending operations—refresh to check).

This architecture ensures the app is fully decentralized, running entirely on ICP without relying on centralized servers, while bridging to Solana securely.

## User Guide

### Getting Started
1. **Access the App**: Open the deployed frontend URL (e.g., via ICP dashboard or local dfx deploy). The interface is simple: Auth options at the top, ICP and SOL sections below.
2. **Choose Authentication Method**:
   - At the top of the page, select either "Use Internet Identity" or "Use Phantom Wallet".
   - **Internet Identity**: Click "Login with Internet Identity". This uses ICP's secure, device-bound auth—no passwords needed.
   - **Phantom Wallet**: Click "Connect Phantom". Ensure Phantom is installed in your browser; it will prompt for connection.
   - Switching methods logs out the other for security.
3. **View Balances and Addresses**:
   - Once authenticated, your ICP and SOL deposit addresses will appear.
   - Click "Refresh ICP Balance" or "Refresh SOL Balance" to update. Note: SOL refreshes may take up to 1 minute due to HTTPS outcalls and consensus across ICP replicas.
   - Copy addresses with the "Copy ICP Addr" or "Copy SOL Addr" buttons to deposit funds.
4. **Deposit Assets**:
   - Send ICP to the displayed ICP deposit address (a subaccount on the ICP ledger).
   - Send SOL to the displayed SOL deposit address (derived from your auth key).
   - Refresh balances after deposits confirm (ICP: ~1-2 seconds; SOL: ~30-60 seconds due to Solana finality and ICP consensus).
5. **Transfer Assets**:
   - **ICP Transfers**: Enter recipient address and amount. No extra fees beyond ledger (0.0001 ICP). Confirm and send.
   - **SOL Transfers**: Enter recipient Solana address and amount (in SOL). Requires at least 0.0003 ICP in your balance for the service fee (0.0002 ICP service + 0.0001 ICP ledger). This fee covers ICP's outcall costs—fund your ICP subaccount first if needed.
   - Transfers use your chosen auth method for signing (II via canister principals; Phantom via message signing).
   - Latency: Expect 10-60 seconds for completion due to HTTPS outcalls (querying Solana slots/blockhashes) and ICP consensus. A "Latest Transaction" section shows status.
6. **Important Notes on Latency**:
   - Operations involving Solana (e.g., SOL balance refresh, transfers) use ICP's HTTPS outcalls to multiple Solana RPC providers. Each of ICP's 13+ replicas queries independently, and results are agreed upon via consensus—this ensures security but adds delay (typically 10-60 seconds).
   - ICP-only ops (e.g., ICP transfers) are faster (~1-2 seconds).
   - If a transfer times out, it may still succeed—refresh balances after 15-30 seconds.
7. **Troubleshooting**:
   - **Balance Refresh Errors**: Often due to temporary consensus issues or network variance. Best fix: Refresh the page and log in again.
   - **Insufficient Funds for SOL Transfer**: Ensure your ICP balance covers the 0.0003 ICP fee. Deposit ICP first.
   - **Phantom Signature Issues**: Ensure you're on Solana Mainnet in Phantom.
   - **Timeouts/Processing Messages**: Common with outcalls; wait and refresh. If persistent, check Solana explorer for txids.
   - For other bugs, clear browser cache or try incognito mode.

This app's ability to unify ICP and Solana under one roof, with secure cross-chain transfers, makes it a pioneer in multi-chain wallets—try it and experience the future of decentralized asset management!

## Running inside ICP Ninja

1. Upload the repository to ICP Ninja.
2. Ensure the backend canister ID is available:
   - If you have already deployed the backend to mainnet, update `src/ic_sol_wallet_frontend/assets/canister_ids.json` to include the `ic` canister ID.
   - To point at a locally deployed backend, add a `local` entry with the replica canister ID and start the replica before opening the editor.
3. Open `src/ic_sol_wallet_frontend/assets/index.html` in the in-browser preview. The module loader will fetch DFINITY libraries from `cdn.jsdelivr.net` automatically.

## Local Development Workflow

```bash
# Start a local replica
dfx start --background

# Deploy backend and asset canisters, regenerating the candid bindings
dfx deploy
```

After deployment the asset canister URL (shown in the deploy output) will serve `index.html`. Append `?canisterId=<asset_canister_id>` when opening it locally. Append `?canisterId=<asset_canister_id>` when opening it locally. Update `src/ic_sol_wallet_frontend/assets/canister_ids.json` with the generated backend ID so the frontend can discover the right canister.

To stop the local replica run `dfx stop`.

## Configuration Files

- `canister_ids.json` (project root) mirrors the format that `dfx deploy --network ic` produces. Keep it in sync with any live deployments so the CDN-loaded frontend knows which backend to talk to.
- `dfx.json` declares the backend Rust canister and the static asset canister.

## Testing

The backend canister uses Rust. Build it with:

```bash
cargo check
```

Additional project-specific tests can be added under the `tests/` directory.