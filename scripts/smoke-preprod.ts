/**
 * smoke-preprod.ts — one full live auction cycle against a deployed
 * AmplopAuction contract on Midnight PREPROD:
 *
 *   seller.createAuction → bidder1.commitBid(500) + bidder2.commitBid(800)
 *   → (wait out the commit window) → both revealBid
 *   → getHighestBid == 800 → (wait out the reveal window)
 *   → seller.finalize → seller.verifyReceipt(800, 2, 2) == true
 *
 * Honest scope: ONE wallet plays all three roles (seller + both bidders),
 * each with its own privateStateId + secretKey, exactly like separate
 * callers except for the shared fee wallet. This is a liveness smoke test
 * of the deployed circuits, not a multi-party trial. Deposits/settlement
 * are ledger accounting in the Phase 1 contract design (see README).
 *
 * Deadlines are ledger block times in SECONDS. The cycle uses a 5-minute
 * commit window and a 5-minute reveal window, so a full run takes ~11
 * minutes plus proving/submission time. Windows are env-tunable
 * (COMMIT_WINDOW_SEC / REVEAL_WINDOW_SEC, minimum 120 each).
 *
 * Run (deploy first, see scripts/deploy-preprod.ts):
 *   CONTRACT_ADDRESS=<deployed address> WALLET_SEED='...' \
 *   BLOCKFROST_PROJECT_ID='...' npx tsx scripts/smoke-preprod.ts
 */

import { createHash, randomBytes } from 'node:crypto';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { Contract } from '../src/managed/AmplopAuction/contract/index.js';
import {
  amplopWitnesses,
  amplopZkConfigPath,
  buildProviders,
  buildWalletProvider,
  requireRunEnv,
} from './deploy-preprod.js';

// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

async function waitUntil(targetSec: bigint, label: string): Promise<void> {
  for (;;) {
    const remaining = Number(targetSec - nowSec());
    if (remaining <= 0) return;
    console.log(`  …waiting for ${label} (${remaining}s)`);
    await sleep(Math.min(remaining, 30) * 1000);
  }
}

/** Retry a phase-gated circuit call while the ledger clock catches up. */
async function withPhaseRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 8,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.log(`  ${label}: attempt ${i}/${attempts} failed, retrying in 20s…`);
      await sleep(20_000);
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const contractAddress = process.env.CONTRACT_ADDRESS?.trim();
  if (!contractAddress) {
    console.error(
      'ERROR: CONTRACT_ADDRESS env var is not set (address printed by deploy-preprod.ts). Aborting.',
    );
    process.exit(1);
  }
  const commitWindow = BigInt(
    Math.max(120, Number(process.env.COMMIT_WINDOW_SEC ?? 300)),
  );
  const revealWindow = BigInt(
    Math.max(120, Number(process.env.REVEAL_WINDOW_SEC ?? 300)),
  );

  const seed = requireRunEnv();
  const zkConfigPath = amplopZkConfigPath();

  console.log('Building wallet from seed (seed stays in memory only)…');
  const walletProvider = await buildWalletProvider(seed);
  console.log(
    `Wallet synced. Coin public key: ${walletProvider.getCoinPublicKey()}`,
  );
  const providers = buildProviders(walletProvider, zkConfigPath);

  const compiledContract = CompiledContract.make(
    'amplop-auction',
    Contract,
  ).pipe(
    CompiledContract.withWitnesses(amplopWitnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );

  // One private state per role; run-unique ids so re-runs start clean.
  const runId = Date.now().toString(36);
  const role = async (name: string) =>
    findDeployedContract(providers, {
      compiledContract,
      contractAddress,
      privateStateId: `amplop-smoke-${runId}-${name}`,
      initialPrivateState: { secretKey: randomBytes(32) },
    });
  const seller = await role('seller');
  const bidder1 = await role('bidder1');
  const bidder2 = await role('bidder2');

  try {
    const t0 = nowSec();
    const commitDeadline = t0 + commitWindow;
    const revealDeadline = commitDeadline + revealWindow;
    const itemHash = new Uint8Array(
      createHash('sha256').update('Amplop preprod smoke item').digest(),
    );
    const sellerSecret = randomBytes(32);
    const secret1 = randomBytes(32);
    const secret2 = randomBytes(32);

    console.log(
      `Creating auction (reserve 100, deposit 10, commit < ${commitDeadline}, reveal < ${revealDeadline})…`,
    );
    const created = await seller.callTx.createAuction(
      itemHash,
      100n,
      10n,
      commitDeadline,
      revealDeadline,
      sellerSecret,
    );
    const auctionId = created.private.result as Uint8Array;
    console.log(`  auctionId: ${hex(auctionId)}  tx: ${created.public.txId}`);

    console.log('Committing bids: bidder1 = 500, bidder2 = 800…');
    const c1 = await bidder1.callTx.commitBid(auctionId, 500n, secret1);
    console.log(`  bidder1 committed  tx: ${c1.public.txId}`);
    const c2 = await bidder2.callTx.commitBid(auctionId, 800n, secret2);
    console.log(`  bidder2 committed  tx: ${c2.public.txId}`);

    await waitUntil(commitDeadline + 5n, 'commit window to close');
    console.log('Revealing bids…');
    const r1 = await withPhaseRetry('reveal bidder1', () =>
      bidder1.callTx.revealBid(auctionId, 500n, secret1),
    );
    console.log(`  bidder1 revealed  tx: ${r1.public.txId}`);
    const r2 = await withPhaseRetry('reveal bidder2', () =>
      bidder2.callTx.revealBid(auctionId, 800n, secret2),
    );
    console.log(`  bidder2 revealed  tx: ${r2.public.txId}`);

    const highest = await seller.callTx.getHighestBid(auctionId);
    console.log(
      `  getHighestBid: ${highest.private.result} (expected 800)  tx: ${highest.public.txId}`,
    );
    if (highest.private.result !== 800n) {
      throw new Error(
        `highest bid mismatch: got ${highest.private.result}, expected 800`,
      );
    }

    await waitUntil(revealDeadline + 5n, 'reveal window to close');
    console.log('Finalizing…');
    const fin = await withPhaseRetry('finalize', () =>
      seller.callTx.finalize(auctionId, sellerSecret),
    );
    const receipt = fin.private.result as Uint8Array;
    console.log(`  receipt: ${hex(receipt)}  tx: ${fin.public.txId}`);

    const ver = await seller.callTx.verifyReceipt(auctionId, 800n, 2n, 2n);
    console.log(
      `  verifyReceipt(800, 2, 2): ${ver.private.result}  tx: ${ver.public.txId}`,
    );
    if (ver.private.result !== true) {
      throw new Error('verifyReceipt did not return true');
    }

    console.log('');
    console.log('✅ SMOKE CYCLE PASSED on preprod');
    console.log(`   Contract: ${contractAddress}`);
    console.log(`   Auction:  ${hex(auctionId)}`);
    console.log(`   Winner:   bidder2 @ 800 (first-price)`);
    console.log(`   Receipt:  ${hex(receipt)}`);
  } finally {
    await walletProvider.stop();
  }
}

main().catch((e) => {
  console.error('Smoke cycle failed:', e);
  process.exit(1);
});
