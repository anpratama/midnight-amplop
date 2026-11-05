/**
 * deploy-preprod.ts — deploy the AmplopAuction contract to Midnight PREPROD.
 *
 * Wiring follows the current midnight-js 4.x generation (FluentWalletBuilder
 * + MidnightWalletProvider.withWallet + initializeMidnightProviders +
 * CompiledContract pipe form), the same assembly that type-checked for the
 * Private Poll registry script on 2026-10-31 against the pinned packages in
 * this repo's package.json (midnight-js-* 4.1.1, testkit-js 4.1.1,
 * wallet-sdk 1.2.0, compact-runtime 0.16.0, compactc 0.31.1).
 *
 * It has NOT been run against preprod yet: deployment needs a funded wallet
 * and a local proof server, which live on the deploying machine (see
 * scripts/RUNBOOK-preprod.md). The seed is read from the WALLET_SEED env var
 * at run time only — never logged (buildWithoutStarting, not
 * MidnightWalletProvider.build), never written to disk.
 *
 * Network parameters (preprod): Blockfrost is the public Preprod indexer +
 * RPC provider (Midnight-hosted preprod endpoints were retired 2026-10-09).
 * Every request needs a Midnight Preprod project token:
 *   indexer (GraphQL): https://midnight-preprod.blockfrost.io/api/v0?project_id=<token>
 *   indexer (WS):      wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=<token>
 *   node RPC:          https://rpc.midnight-preprod.blockfrost.io?project_id=<token>
 *   node (WS):         wss://rpc.midnight-preprod.blockfrost.io?project_id=<token>
 *   proof server:      http://127.0.0.1:6300 (local Docker, see runbook)
 * URLs can be overridden via PREPROD_*_URL / PROOF_SERVER_URL env vars.
 *
 * Run (after `npm install` and `npm run compact`):
 *   WALLET_SEED='...' BLOCKFROST_PROJECT_ID='...' npx tsx scripts/deploy-preprod.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {
  DustSecretKey,
  ZswapSecretKeys,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import {
  FluentWalletBuilder,
  MidnightWalletProvider,
  initializeMidnightProviders,
  type EnvironmentConfiguration,
} from '@midnight-ntwrk/testkit-js';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk';
import {
  Contract,
  type Witnesses,
} from '../src/managed/AmplopAuction/contract/index.js';

// ---------------------------------------------------------------------------

const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID?.trim();
const withBlockfrostKey = (url: string) =>
  BLOCKFROST_PROJECT_ID
    ? `${url}?project_id=${encodeURIComponent(BLOCKFROST_PROJECT_ID)}`
    : url;

const CONFIG = {
  indexer:
    process.env.PREPROD_INDEXER_URL ??
    withBlockfrostKey('https://midnight-preprod.blockfrost.io/api/v0'),
  indexerWS:
    process.env.PREPROD_INDEXER_WS_URL ??
    withBlockfrostKey('wss://midnight-preprod.blockfrost.io/api/v0/ws'),
  node:
    process.env.PREPROD_NODE_URL ??
    withBlockfrostKey('https://rpc.midnight-preprod.blockfrost.io'),
  nodeWS:
    process.env.PREPROD_NODE_WS_URL ??
    withBlockfrostKey('wss://rpc.midnight-preprod.blockfrost.io'),
  proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
};

const env: EnvironmentConfiguration = {
  walletNetworkId: NetworkId.NetworkId.PreProd,
  networkId: 'preprod',
  indexer: CONFIG.indexer,
  indexerWS: CONFIG.indexerWS,
  node: CONFIG.node,
  nodeWS: CONFIG.nodeWS,
  proofServer: CONFIG.proofServer,
  faucet: undefined,
};

// Amplop's only witness: the caller's identity secret key, supplied from
// private state at transaction time. Deployment itself never calls it (the
// constructor takes no arguments).
type AmplopPrivateState = { secretKey: Uint8Array };
const witnesses: Witnesses<AmplopPrivateState> = {
  localSecretKey: ({ privateState }): [AmplopPrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
};

export type AmplopCircuitKeys =
  | 'createAuction'
  | 'commitBid'
  | 'revealBid'
  | 'finalize'
  | 'verifyReceipt'
  | 'getHighestBid';

/** Shared preprod environment config (also used by smoke-preprod.ts). */
export function preprodEnv(): EnvironmentConfiguration {
  return env;
}

/** Fail-closed env checks shared by the deploy and smoke scripts. */
export function requireRunEnv(): string {
  const seed = process.env.WALLET_SEED?.trim();
  if (!seed) {
    console.error(
      'ERROR: WALLET_SEED env var is not set. Aborting — no seed, no transaction.',
    );
    process.exit(1);
  }
  if (
    !BLOCKFROST_PROJECT_ID &&
    (!process.env.PREPROD_INDEXER_URL ||
      !process.env.PREPROD_NODE_URL ||
      !process.env.PREPROD_NODE_WS_URL)
  ) {
    console.error(
      'ERROR: BLOCKFROST_PROJECT_ID env var is not set, and not all Blockfrost URLs were overridden. Blockfrost serves Preprod indexer + RPC and every request needs a Midnight Preprod project token (create one at blockfrost.io). Aborting before any wallet sync attempt.',
    );
    process.exit(1);
  }
  return seed;
}

/** Build + start the wallet provider (seed never logged). Caller must stop() it. */
export async function buildWalletProvider(seed: string) {
  setNetworkId('preprod');
  const logger = pino({ level: 'info' });
  const builder = FluentWalletBuilder.forEnvironment(env);
  const { wallet, seeds, keystore } = seed.includes(' ')
    ? await builder.withMnemonic(seed).buildWithoutStarting()
    : await builder.withSeed(seed).buildWithoutStarting();
  const walletProvider = await MidnightWalletProvider.withWallet(
    logger,
    env,
    wallet,
    ZswapSecretKeys.fromSeed(seeds.shielded),
    DustSecretKey.fromSeed(seeds.dust),
    keystore,
  );
  await walletProvider.start();
  return walletProvider;
}

/** Full provider set for Amplop circuits, bound to one wallet. */
export function buildProviders(
  walletProvider: Awaited<ReturnType<typeof buildWalletProvider>>,
  zkConfigPath: string,
) {
  return initializeMidnightProviders<AmplopCircuitKeys, AmplopPrivateState>(
    walletProvider,
    env,
    {
      privateStateStoreName: 'amplop-state',
      zkConfigPath,
    },
  );
}

/** The contract's witnesses (shared with smoke-preprod.ts). */
export const amplopWitnesses = witnesses;

/** Absolute path of the compiled contract assets (keys + zkir + contract JS). */
export function amplopZkConfigPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/managed/AmplopAuction',
  );
}

async function main(): Promise<void> {
  const seed = requireRunEnv();
  const zkConfigPath = amplopZkConfigPath();
  for (const sub of ['contract/index.js', 'keys', 'zkir']) {
    if (!fs.existsSync(path.join(zkConfigPath, sub))) {
      console.error(
        `ERROR: compiled contract artifact missing under ${zkConfigPath}: ${sub}. Run: npm run compact`,
      );
      process.exit(1);
    }
  }

  console.log('Building wallet from seed (seed stays in memory only)…');
  const walletProvider = await buildWalletProvider(seed);
  console.log(
    `Wallet synced. Coin public key: ${walletProvider.getCoinPublicKey()}`,
  );
  console.log(
    'If the balance above was 0, fund this wallet (tNIGHT + tDUST) before retrying — the deploy cannot balance its fee otherwise.',
  );

  const providers = buildProviders(walletProvider, zkConfigPath);

  // Deploy-time placeholder only: deployment runs no circuit, so this key
  // never signs anything. Every later caller (seller / bidder) MUST use
  // their own privateStateId + secretKey — see smoke-preprod.ts.
  const deployPrivateState: AmplopPrivateState = {
    secretKey: randomBytes(32),
  };

  console.log('Deploying AmplopAuction to preprod…');
  let address: string;
  try {
    const compiledContract = CompiledContract.make(
      'amplop-auction',
      Contract,
    ).pipe(
      CompiledContract.withWitnesses(witnesses),
      CompiledContract.withCompiledFileAssets(zkConfigPath),
    );
    const deployed = await deployContract(providers, {
      compiledContract,
      privateStateId: 'amplopAuction',
      initialPrivateState: deployPrivateState,
    });
    address = deployed.deployTxData.public.contractAddress;
  } finally {
    await walletProvider.stop();
  }

  console.log('');
  console.log('✅ AmplopAuction deployed to PREPROD');
  console.log(`   Contract address: ${address}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Record the address in the README / AKINDO submission.');
  console.log('  2. Run the live smoke cycle:');
  console.log(
    '     CONTRACT_ADDRESS=<address> WALLET_SEED=... BLOCKFROST_PROJECT_ID=... npx tsx scripts/smoke-preprod.ts',
  );
  console.log('  3. Keep the seed out of shell history.');
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error('Deploy failed:', e);
    process.exit(1);
  });
}
