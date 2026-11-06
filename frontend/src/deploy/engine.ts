/**
 * Deploy + smoke-cycle engine for the browser deploy page.
 * Ported from scripts/deploy-preprod.ts + scripts/smoke-preprod.ts
 * (which are blocked by the SDK wallet's cold dust sync), with the seed
 * wallet replaced by the user's Lace wallet via ./providers.ts.
 *
 * Honest scope of the smoke cycle: ONE wallet (the user's Lace) plays
 * seller + both bidders, each with its own privateStateId + secretKey,
 * exactly like the Node version. Deposits/settlement are ledger
 * accounting in the Phase 1 contract design (see README).
 */
import {
  deployContract,
  findDeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { Contract } from '../managed/AmplopAuction/contract/index.js';
import type { BrowserProviders } from './providers.js';

export type LogFn = (msg: string) => void;

type AmplopPrivateState = { secretKey: Uint8Array };

const witnesses = {
  localSecretKey: ({
    privateState,
  }: {
    privateState: AmplopPrivateState;
  }): [AmplopPrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
};

function compiledAmplop() {
  return CompiledContract.make('amplop-auction', Contract).pipe(
    CompiledContract.withWitnesses(witnesses as never),
    CompiledContract.withCompiledFileAssets('/zk'),
  );
}

const randomBytes = (n: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(n));

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return new Uint8Array(digest);
}

export async function deployAmplop(
  bp: BrowserProviders,
  log: LogFn,
): Promise<string> {
  setNetworkId('preprod');
  const providers = bp.providers as never;
  log('Deploying AmplopAuction to preprod via Lace…');
  log('(Approve the deploy transaction in your Lace wallet when prompted.)');
  const deployed = await deployContract(providers, {
    compiledContract: compiledAmplop(),
    privateStateId: 'amplopAuction',
    initialPrivateState: { secretKey: randomBytes(32) } as AmplopPrivateState,
  });
  const address = deployed.deployTxData.public.contractAddress;
  log(`✅ Deployed. Contract address: ${address}`);
  log(`   Deploy tx: ${deployed.deployTxData.public.txId}`);
  return address;
}

async function waitUntil(
  targetSec: bigint,
  label: string,
  log: LogFn,
): Promise<void> {
  for (;;) {
    const remaining = Number(targetSec - nowSec());
    if (remaining <= 0) return;
    log(`  …waiting for ${label} (${remaining}s) — keep this tab open`);
    await sleep(Math.min(remaining, 30) * 1000);
  }
}

async function withPhaseRetry<T>(
  label: string,
  fn: () => Promise<T>,
  log: LogFn,
  attempts = 8,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      log(`  ${label}: attempt ${i}/${attempts} failed, retrying in 20s…`);
      await sleep(20_000);
    }
  }
  throw lastErr;
}

export async function smokeAmplop(
  bp: BrowserProviders,
  contractAddress: string,
  log: LogFn,
): Promise<void> {
  setNetworkId('preprod');
  const providers = bp.providers as never;
  const compiledContract = compiledAmplop();

  const runId = Date.now().toString(36);
  const role = (name: string) =>
    findDeployedContract(providers, {
      compiledContract,
      contractAddress,
      privateStateId: `amplop-smoke-${runId}-${name}`,
      initialPrivateState: { secretKey: randomBytes(32) } as AmplopPrivateState,
    });
  const seller = await role('seller');
  const bidder1 = await role('bidder1');
  const bidder2 = await role('bidder2');

  const commitWindow = 180n;
  const revealWindow = 180n;
  const t0 = nowSec();
  const commitDeadline = t0 + commitWindow;
  const revealDeadline = commitDeadline + revealWindow;
  const itemHash = await sha256('Amplop preprod smoke item');
  const sellerSecret = randomBytes(32);
  const secret1 = randomBytes(32);
  const secret2 = randomBytes(32);

  log(
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
  log(`  auctionId: ${hex(auctionId)}  tx: ${created.public.txId}`);

  log('Committing bids: bidder1 = 500, bidder2 = 800 (approve each in Lace)…');
  const c1 = await bidder1.callTx.commitBid(auctionId, 500n, secret1);
  log(`  bidder1 committed  tx: ${c1.public.txId}`);
  const c2 = await bidder2.callTx.commitBid(auctionId, 800n, secret2);
  log(`  bidder2 committed  tx: ${c2.public.txId}`);

  await waitUntil(commitDeadline + 5n, 'commit window to close', log);
  log('Revealing bids…');
  const r1 = await withPhaseRetry(
    'reveal bidder1',
    () => bidder1.callTx.revealBid(auctionId, 500n, secret1),
    log,
  );
  log(`  bidder1 revealed  tx: ${r1.public.txId}`);
  const r2 = await withPhaseRetry(
    'reveal bidder2',
    () => bidder2.callTx.revealBid(auctionId, 800n, secret2),
    log,
  );
  log(`  bidder2 revealed  tx: ${r2.public.txId}`);

  const highest = await seller.callTx.getHighestBid(auctionId);
  log(
    `  getHighestBid: ${highest.private.result} (expected 800)  tx: ${highest.public.txId}`,
  );
  if (highest.private.result !== 800n) {
    throw new Error(
      `highest bid mismatch: got ${highest.private.result}, expected 800`,
    );
  }

  await waitUntil(revealDeadline + 5n, 'reveal window to close', log);
  log('Finalizing…');
  const fin = await withPhaseRetry(
    'finalize',
    () => seller.callTx.finalize(auctionId, sellerSecret),
    log,
  );
  const receipt = fin.private.result as Uint8Array;
  log(`  receipt: ${hex(receipt)}  tx: ${fin.public.txId}`);

  const ver = await seller.callTx.verifyReceipt(auctionId, 800n, 2n, 2n);
  log(`  verifyReceipt(800, 2, 2): ${ver.private.result}  tx: ${ver.public.txId}`);
  if (ver.private.result !== true) {
    throw new Error('verifyReceipt did not return true');
  }

  log('');
  log('✅ SMOKE CYCLE PASSED on preprod');
  log(`   Contract: ${contractAddress}`);
  log(`   Auction:  ${hex(auctionId)}`);
  log('   Winner:   bidder2 @ 800 (first-price)');
  log(`   Receipt:  ${hex(receipt)}`);
}
