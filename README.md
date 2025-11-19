# dMail — Decentralized Email on Filecoin Onchain Cloud + ENS

dMail is an end-to-end encrypted messaging prototype that stores every message and mailbox index through the Synapse SDK (Filecoin Onchain Cloud) while using ENS text records as resolvable pointers. It ships with a React front-end, Node CLI demo scripts, and shared crypto/storage helpers.

> **References**: Implementation aligned with the [Filecoin Onchain Cloud docs](https://synapse-sdk-docs.netlify.app/) and the [official ENS + Filecoin storage demo](https://github.com/FIL-Builders/filecoin-pin-ens-demo).

## Architecture Overview

```
┌────────────────────────────┐       ┌────────────────────────────┐
│ React Frontend (Vite)      │◄──────┤ ENS (Calibration / Sepolia)│
│  - Wallet connect (ethers) │       │  - dmail:mailbox text record│
│  - Compose / Inbox UI      │       │  - dmail:pubkey text record │
│  - Synapse uploads         │       └──────────────┬──────────────┘
└──────────────┬─────────────┘                      │
               │ storage uploads (wallet or session)│ set/get text
               ▼                                    │
┌────────────────────────────┐                      │
│ Filecoin Onchain Cloud     │◄─────────────────────┘
│  - `synapseUpload`     │
│  - `synapseFetch`      │
└──────────────┬─────────────┘
               │ CID list
               ▼
┌────────────────────────────┐
│ Mailbox JSON (mailbox CID) │
│  - List of encrypted email │
│    object CIDs             │
└────────────────────────────┘

Shared library `@dmail/core` exports:
- `synapseUpload` / `synapseFetch` — Synapse-backed Filecoin storage helpers
- `getMailboxUploadResult` / `setMailboxUploadResult` — ENS text record helpers (`dmail:mailbox`)
- `encryptEmail` / `decryptEmail` — ECIES (EthCrypto) utilities
- `appendEmailEntry`, `persistMailbox`, `loadMailboxFromCid` — mailbox management
```

Additional planning notes live in `docs/architecture.md`.

## Repository Layout

```
frontend/           React + Vite UI (connect wallet, read inbox, compose)
scripts/            CLI demos (sendEmail.js, readInbox.js)
packages/core/      Shared helpers (Filecoin storage via Synapse, ENS, crypto, mailbox)
docs/               Architecture notes, env template
hardhat.config.js   Calibration testnet configuration (chainId 314159)
```

## Prerequisites

- Node.js 18+ (for global `fetch`, `Blob`, `FormData`)
- npm 10+
- MetaMask browser extension
- Filecoin Onchain Cloud access (wallet private key or session key provisioned for Synapse uploads)
- ENS names controlled on a network compatible with your RPC (Sepolia / Mainnet / Calibration L2)

## Complete Setup Guide

Follow these steps to get dMail fully working:

### Step 1: Clone and Install

```bash
# Clone the repository (if not already done)
git clone <your-repo-url>
cd mail

# Install dependencies
npm install
```

### Step 2: Configure Filecoin Onchain Cloud / Synapse

> Need the full checklist? See `docs/COMPLETE_SETUP_GUIDE.md`.

1. **Request access**:
   - Visit [filecoin.cloud](https://filecoin.cloud) and join the waitlist/beta.
   - The FilOz team will provision either a funded wallet or a session key tied to your wallet.

2. **Choose your auth mode**:
   - **Private key** – simplest path for local development. Fund it with Calibration tFIL + USDFC.
   - **Session key** – keep the owner wallet cold and use a delegated session key (requires existing dataset/allowances).

3. **Record the credentials**:
   - Capture the wallet address, private key or session key, RPC URL, and (optionally) Warm Storage address.
   - Store them in `.env` using the variables shown below. Never commit these secrets.

### Step 3: Get ENS Testnames on Calibration/Sepolia

**Option A: Use Sepolia ENS (Recommended for testing)**
1. Get Sepolia ETH from [Sepolia Faucet](https://sepoliafaucet.com/)
2. Visit [ENS App](https://app.ens.domains/)
3. Switch network to Sepolia in MetaMask
4. Search and register a `.eth` name (testnames are free on Sepolia)
5. Note: You'll need your wallet's private key later for decryption

**Option B: Use Calibration Testnet**
1. Add Calibration network to MetaMask:
   - Network Name: `Filecoin Calibration`
   - RPC URL: `https://api.calibration.node.glif.io/rpc/v1`
   - Chain ID: `314159`
   - Currency Symbol: `tFIL`
2. Get testnet tokens from [Calibration Faucet](https://faucet.calibnet.chainsafe-fil.io/funds.html)
3. Register ENS names through Calibration-compatible ENS registry

### Step 4: Configure Environment Variables

```bash
# Copy the sample env file
cp docs/sample.env .env

# Edit .env with your credentials
nano .env  # or use your preferred editor
```

**Required variables for CLI:**
```env
# Ethereum/ENS Configuration
ETH_RPC_URL=https://api.calibration.node.glif.io/rpc/v1
ETH_PRIVATE_KEY=0x...your_wallet_private_key...

# Filecoin Storage Configuration
# Option A: private key auth
FILECOIN_PRIVATE_KEY=0x...your_filecoin_private_key...
# Option B: session key auth
FILECOIN_WALLET_ADDRESS=0x...wallet_address_for_synapse...
FILECOIN_SESSION_KEY=0x...session_key...
FILECOIN_RPC_URL=https://api.calibration.node.glif.io/rpc/v1
FILECOIN_GATEWAY=https://w3s.link/ipfs
FILECOIN_DATASET_ID=
FILECOIN_DATASET_CREATE_NEW=false
```

**Required variables for Frontend:**
```env
# Frontend (Vite) variables - prefix with VITE_
VITE_ETH_RPC_URL=https://api.calibration.node.glif.io/rpc/v1
VITE_FILECOIN_PRIVATE_KEY=0x...your_filecoin_private_key...
VITE_FILECOIN_WALLET_ADDRESS=0x...your_filecoin_wallet...
VITE_FILECOIN_SESSION_KEY=0x...session_key_if_applicable...
VITE_FILECOIN_RPC_URL=https://api.calibration.node.glif.io/rpc/v1
VITE_FILECOIN_GATEWAY=https://w3s.link/ipfs
```

### Step 5: Set Up Encryption Keys

Each user needs to publish their public encryption key to ENS:

1. **Derive your public key from your wallet's private key**:
   ```bash
   # Use the helper script:
   npm run derive:pubkey -- 0x...your_private_key...
   
   # Or with environment variable:
   ETH_PRIVATE_KEY=0x... npm run derive:pubkey
   ```
   
   This will output your public key that you need to store in ENS.

2. **Set ENS text record `dmail:pubkey`**:
   - Option A: Use ENS Manager UI
     - Go to [ENS App](https://app.ens.domains/)
     - Select your ENS name
     - Go to "Records" tab
     - Add text record: Key = `dmail:pubkey`, Value = `0x04...your_public_key...`
   
   - Option B: Use the dMail CLI (once we add this helper):
     ```bash
     # Coming soon: npm run set:pubkey -- --ens yourname.eth --pubkey 0x04...
     ```

### Step 6: Test the CLI (Send & Read Emails)

```bash
# Send an email
npm run send:cli -- \
  --to recipient.eth \
  --subject "Hello from dMail" \
  --body "This is my first encrypted email!"

# Read inbox
npm run read:cli -- --ens recipient.eth --limit 5
```

### Step 7: Run the Frontend

```bash
# Start development server
npm run dev
```

The frontend will be available at `http://localhost:5173` (or the port Vite suggests).

### Step 8: Use the Frontend

1. **Connect Wallet**:
   - Click the wallet icon (🔌) in the header
   - Approve MetaMask connection
   - Your ENS name or wallet address will appear

2. **Enter Private Key** (for decryption):
   - Scroll to the bottom of the sidebar
   - Find "🔐 Private Key" section
   - Enter your wallet's private key (starts with `0x...`)
   - ⚠️ **Why?** Emails are encrypted with your public key, so you need the matching private key to decrypt them. MetaMask doesn't expose private keys for security reasons, so manual entry is required for now.
   - **Note**: This key stays in your browser only. For production, consider using MetaMask's `eth_decrypt` (requires changes to encryption scheme).

3. **Refresh Inbox**:
   - Click "🔄 Refresh" in the sidebar
   - Your emails will load

4. **Read Emails**:
   - Click any email in the list
   - It will decrypt and display in the right panel

5. **Send Emails**:
   - Click "✏️ Compose" button
   - Enter recipient ENS name (e.g., `alice.eth`)
   - **The public key will be automatically fetched from ENS** when you enter the recipient's name
   - Fill in subject and message
   - Click "📤 Send"
   - The email will be encrypted, uploaded via Synapse to Filecoin storage, and the recipient's mailbox updated

**Note on Recipient Public Key Field:**
- The "Recipient Public Key" field is **automatically hidden** when the public key is successfully fetched from ENS
- It only appears if:
  - ENS lookup fails (recipient hasn't set `dmail:pubkey` record)
  - Network/RPC issues prevent ENS lookup
- You can manually enter the public key if the auto-fetch fails
- This field is optional and mainly for edge cases or testing

## Why Private Key is Required

**Question: Why do I need to enter my private key?**

**Answer**: dMail uses end-to-end encryption (E2EE). When someone sends you an email:
1. They encrypt it with **your public key** (stored in ENS `dmail:pubkey`)
2. The encrypted email is stored on Filecoin Onchain Cloud (via Synapse)
3. To read it, you need **your private key** to decrypt it

**Current Limitation**: MetaMask (and most wallets) don't expose private keys for security reasons. So the frontend asks you to enter it manually.

**Future Solution**: We can switch to MetaMask's `eth_getEncryptionPublicKey` and `eth_decrypt` APIs, which handle encryption/decryption in MetaMask without exposing your private key. This requires changes to the encryption scheme (using MetaMask's format instead of EthCrypto).

## Environment

Copy `docs/sample.env` to `.env` and fill in secrets:

```bash
cp docs/sample.env .env
```

Key values:

| Variable | Purpose |
| --- | --- |
| `FILECOIN_PRIVATE_KEY` / `FILECOIN_SESSION_KEY` | Auth for Synapse uploads (choose one path) |
| `FILECOIN_WALLET_ADDRESS` | Wallet delegated to Synapse (session key mode) |
| `FILECOIN_RPC_URL` | Filecoin RPC endpoint (Calibration or Mainnet) |
| `FILECOIN_WARM_STORAGE_ADDRESS` | Optional Warm Storage contract override |
| `ETH_RPC_URL` | Ethereum JSON-RPC endpoint (use Sepolia / Calibration bridge) |
| `WALLET_PRIVATE_KEY` | Wallet controlling ENS records + decrypt in CLI |
| `DMAIL_FROM_ENS` | Default sender ENS for CLI |
| `RECIPIENT_PUBLIC_KEY` | Fallback recipient EC public key when ENS `dmail:pubkey` missing |
| `VITE_*` | Frontend overrides consumed by Vite |

See `docs/COMPLETE_SETUP_GUIDE.md` for a fully scripted walkthrough (wallet funding, ENS records, CLI commands).

Expose the recipient’s encryption public key through ENS (`dmail:pubkey`) or pass it via CLI/env if still staging.

## Installation

```bash
npm install
```

This installs dependencies for the monorepo (`frontend`, `scripts`, `packages/core`).

## Running the Frontend Demo

```bash
npm run dev
```

Open the local URL, connect your wallet (MetaMask), and supply:

1. Private key for decrypting inbound messages (demo input field).
2. Recipient ENS name + message on the Compose panel.

The UI performs:

1. ENS resolution to fetch `dmail:pubkey` and current `dmail:mailbox`.
2. Client-side encryption via `encryptEmail` (EthCrypto ECIES).
3. Upload of the encrypted JSON through Synapse (`synapseUpload` now wraps the SDK).
4. Mailbox update (append CID, persist to Filecoin storage, update ENS).
5. Inbox refresh + local decryption with `decryptEmail`.

## CLI Demo (Calibration Judges Requirement)

### Send an Email

```bash
npm run send:cli -- \
  --to bob.eth \
  --subject "gm Calibration" \
  --body "Hello from dMail 👋" \
  --attachment ./docs/architecture.md
```

### Read Inbox

```bash
npm run read:cli -- --ens bob.eth --limit 5
```

The scripts log the email CID, updated mailbox CID, and rely on the same shared helpers used by the frontend.

## ENS Text Records

- `dmail:mailbox` — CID pointing to `mailbox.json`.
- `dmail:pubkey` — Hex-encoded secp256k1 public key used for ECIES.

Update via CLI (`setMailboxCid`) or directly through ENS manager wallets. The frontend automatically updates `dmail:mailbox` when sending.

## Filecoin Storage (Synapse SDK)

- Uploads happen through `synapseUpload(buffer)` which streams the encrypted JSON directly to the selected provider via Synapse.
- Retrieval uses `synapseFetch` with the stored provider metadata and piece CID (no gateways required).

Proof of usage:
- Email uploads: metadata tagged `type=dmail-email`, `from`, `to`.
- Mailbox uploads: metadata tagged `type=dmail-mailbox`.
- CLI output displays piece CID + provider information so you can verify it in the Synapse dashboards.

## Calibration Testnet Configuration

- **Chain ID**: `314159`
- **RPC**: `https://api.calibration.node.glif.io/rpc/v1` (set via `ETH_RPC_URL`)
- **Hardhat**: `hardhat.config.js` preconfigured with `calibration` network.
- **MetaMask**: Add custom network (RPC above, chain id 314159, currency `tFIL`).
- **Faucets**:
  - FIL: [https://faucet.calibnet.chainsafe-fil.io/funds.html](https://faucet.calibnet.chainsafe-fil.io/funds.html)
  - USDFC: [https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc](https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc)
- **ENS Testnames**:
  - Use the [ENS Sepolia registrar](https://app.ens.domains/) or Calibration-compatible ENS deployment.
  - After registration, set text records via the dMail CLI or ENS Manager.

## Development Tips

- `@dmail/core` is shared between frontend and CLI. Avoid bundling Node-only APIs there.
- Vite automatically exposes `import.meta.env.VITE_*`.
- For local testing without ENS, pass `--recipient-pubkey` to `sendEmail.js` and skip ENS update with `--dry-run`.
- Lint / format:

  ```bash
  npm run lint
  npm run format
  ```

## Testing the Flows

1. Configure `.env` with your Filecoin private key or session key plus RPC info.
2. Register ENS names owned by the same key (for demo).
3. Publish the recipient `dmail:pubkey`.
4. Run `npm run send:cli` to seed mailbox.
5. Start `npm run dev`, connect wallet, refresh inbox, and decrypt.

## Open Source & Deployment

- Push this repository to GitHub (public) to satisfy the submission requirement.
- Deploy the frontend (e.g., Vercel/Netlify) with the `VITE_*` env vars.
- Share recorded demo showing CLI + UI flows for judges.

## Future Enhancements

- Multi-tenant relayer that owns mailbox ENS updates on behalf of recipients.
- Switch to metamask `eth_getEncryptionPublicKey` / `eth_decrypt` for browser-native E2EE.
- Attachment streaming + large file support via chunked Synapse uploads.
- Automated IPNI validation dashboards leveraging Synapse upload metadata.

---

Built with ❤️ on the Filecoin Calibration testnet.

