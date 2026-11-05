# Amplop — Preprod deploy runbook (Windows)

Deploy runs from **your machine**: it needs your wallet seed and a local
proof server, neither of which can live on the assistant's VM (no Docker
there). Everything else is prepared — the scripts are in this repo and
type-checked against the pinned SDK (midnight-js 4.1.1).

## One-time setup

1. **Docker Desktop** installed and running (WSL2 backend is fine).
2. **Node.js 22+** installed (https://nodejs.org).
3. Clone and install:
   ```powershell
   git clone https://github.com/anpratama/midnight-amplop.git
   cd midnight-amplop
   npm install
   ```
4. **Compiled artifacts**: the GitHub snapshot could not carry the binary
   proving keys, so extract the provided `amplop-managed-artifacts.zip`
   into the repo root (it fills `src/managed/AmplopAuction/keys/` and the
   `*.bzkir` files under `zkir/`). Skip this only if you recompile
   yourself with `npm run compact` (needs compactc 0.31.1, WSL/Linux).

## Wallet (Lace, already funded)

- Lace Midnight network set to **Preprod**; wallet holds **tNIGHT** from
  https://faucet.preprod.midnight.network/ (claim with the **unshielded**
  `mn_addr_preprod1...` address) and **tDUST generated** (Tokens →
  Generate tDUST). The deploy wallet = this Lace wallet's seed.

## Proof server (separate terminal, leave running)

```powershell
docker run -p 6300:6300 midnightntwrk/proof-server:8.1.3
```

## Deploy (PowerShell, in the repo root)

```powershell
$env:WALLET_SEED = "word1 word2 ... word24"   # your Lace seed phrase
$env:BLOCKFROST_PROJECT_ID = "nightpreprod..." # Midnight Preprod token
npx tsx scripts/deploy-preprod.ts
```

Success prints `AmplopAuction deployed to PREPROD` + the contract
address. **Send that address back to the assistant** — it goes into the
AKINDO submission.

## Smoke cycle (~11 minutes, same env vars)

```powershell
$env:CONTRACT_ADDRESS = "<address from the deploy step>"
npx tsx scripts/smoke-preprod.ts
```

Runs one full auction on preprod (create → 2 commits → reveals →
finalize → receipt verification) from the same wallet in three roles and
prints every tx id. Success ends with `SMOKE CYCLE PASSED on preprod`.

## Notes

- The seed is read from the environment only: never committed, never
  logged by these scripts (`buildWithoutStarting` path). Clear it after:
  `Remove-Item Env:WALLET_SEED`.
- If the wallet syncs with balance 0, the faucet/tDUST steps above are
  not finished yet — the deploy cannot pay its fee otherwise.
- First run is the real test of sync + funding; any error output is
  useful as-is — copy it to the assistant for diagnosis.
