/**
 * Browser provider glue for deploying AmplopAuction from the user's own
 * Lace wallet (DApp Connector API v4), instead of a server-side seed
 * wallet. The seed-wallet route is blocked by the SDK's cold dust sync
 * (measured 2026-11-06: ~1.84M dust events replayed at ~40-100/s), while
 * Lace is already synced on the user's machine.
 *
 * Serialization contract (from testkit's DAppConnectorWalletAdapter, the
 * wallet-side reference implementation):
 *   unbound tx  -> hex via tx.serialize()          -> balanceUnsealedTransaction
 *   balanced tx <- Transaction.deserialize('signature','proof','binding', fromHex(hex))
 *   submit      -> api.submitTransaction(hex); txId = tx.identifiers().at(-1)
 */
import { Transaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-utils';
import {
  ZKConfigProvider,
  type ProverKey,
  type VerifierKey,
  type ZKIR,
} from '@midnight-ntwrk/midnight-js-types';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';

// ---------------------------------------------------------------------------
// Minimal typings for the Lace DApp Connector API (v4) — only what we call.

export interface LaceConfiguration {
  indexerUri: string;
  indexerWsUri: string;
  proverServerUri?: string;
  substrateNodeUri: string;
  networkId: string;
}

export interface LaceConnectedApi {
  getConfiguration(): Promise<LaceConfiguration>;
  getShieldedAddresses(): Promise<{
    shieldedAddress: string;
    shieldedCoinPublicKey: string;
    shieldedEncryptionPublicKey: string;
  }>;
  balanceUnsealedTransaction(
    tx: string,
    options?: { payFees?: boolean },
  ): Promise<{ tx: string }>;
  submitTransaction(tx: string): Promise<void>;
  hintUsage?: (methodNames: string[]) => Promise<void>;
}

export interface LaceInitialApi {
  enable(): Promise<LaceConnectedApi>;
  isEnabled(): Promise<boolean>;
}

export function findLace(): LaceInitialApi | undefined {
  const w = window as unknown as {
    midnight?: { mnLace?: LaceInitialApi };
  };
  return w.midnight?.mnLace;
}

// ---------------------------------------------------------------------------

/** ZK artifacts served as static files next to this page (public/zk). */
export class FetchZkConfigProvider extends ZKConfigProvider<string> {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    super();
    this.baseUrl = baseUrl;
  }

  private async fetchBytes(path: string): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/${path}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch ZK artifact ${path}: HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async getZKIR(circuitId: string): Promise<ZKIR> {
    return (await this.fetchBytes(`zkir/${circuitId}.bzkir`)) as ZKIR;
  }

  async getProverKey(circuitId: string): Promise<ProverKey> {
    return (await this.fetchBytes(`keys/${circuitId}.prover`)) as ProverKey;
  }

  async getVerifierKey(circuitId: string): Promise<VerifierKey> {
    return (await this.fetchBytes(
      `keys/${circuitId}.verifier`,
    )) as VerifierKey;
  }
}

/**
 * In-memory private state: fine for a one-shot deploy + smoke session.
 * State is lost on page reload — acceptable here because the smoke cycle
 * creates fresh role states on every run; only the contract address
 * (kept in localStorage by the page) is needed across reloads.
 */
export function inMemoryPrivateStateProvider() {
  let contractAddress = '';
  const states = new Map<string, unknown>();
  const signingKeys = new Map<string, unknown>();
  const scoped = (id: string) => `${contractAddress}:${id}`;
  return {
    setContractAddress(address: string): void {
      contractAddress = address;
    },
    async set(privateStateId: string, state: unknown): Promise<void> {
      states.set(scoped(privateStateId), state);
    },
    async get(privateStateId: string): Promise<unknown> {
      return states.get(scoped(privateStateId)) ?? null;
    },
    async remove(privateStateId: string): Promise<void> {
      states.delete(scoped(privateStateId));
    },
    async clear(): Promise<void> {
      states.clear();
    },
    async setSigningKey(address: string, signingKey: unknown): Promise<void> {
      signingKeys.set(address, signingKey);
    },
    async getSigningKey(address: string): Promise<unknown> {
      return signingKeys.get(address) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------

export interface BrowserProviders {
  config: LaceConfiguration;
  proofServerUri: string;
  providers: {
    privateStateProvider: ReturnType<typeof inMemoryPrivateStateProvider>;
    publicDataProvider: ReturnType<typeof indexerPublicDataProvider>;
    zkConfigProvider: FetchZkConfigProvider;
    proofProvider: ReturnType<typeof httpClientProofProvider>;
    walletProvider: {
      getCoinPublicKey: () => string;
      getEncryptionPublicKey: () => string;
      balanceTx: (tx: never) => Promise<unknown>;
    };
    midnightProvider: {
      submitTx: (tx: never) => Promise<string>;
    };
  };
}

export async function buildBrowserProviders(
  api: LaceConnectedApi,
): Promise<BrowserProviders> {
  const config = await api.getConfiguration();
  const addresses = await api.getShieldedAddresses();
  const zkConfigProvider = new FetchZkConfigProvider(
    `${window.location.origin}/zk`,
  );
  // Lace may omit proverServerUri (deprecated field); Krisna's Lace is
  // configured for the local proof server, which is the sane default.
  const proofServerUri = config.proverServerUri ?? 'http://localhost:6300';

  const walletProvider = {
    getCoinPublicKey: () => addresses.shieldedCoinPublicKey,
    getEncryptionPublicKey: () => addresses.shieldedEncryptionPublicKey,
    balanceTx: async (tx: never): Promise<unknown> => {
      const unbound = tx as { serialize(): Uint8Array };
      const { tx: balancedHex } = await api.balanceUnsealedTransaction(
        toHex(unbound.serialize()),
      );
      return Transaction.deserialize(
        'signature',
        'proof',
        'binding',
        fromHex(balancedHex),
      );
    },
  };

  const midnightProvider = {
    submitTx: async (tx: never): Promise<string> => {
      const finalized = tx as {
        serialize(): Uint8Array;
        identifiers(): string[];
      };
      await api.submitTransaction(toHex(finalized.serialize()));
      const id = finalized.identifiers().at(-1);
      if (!id) throw new Error('Finalized transaction has no identifier');
      return id;
    },
  };

  return {
    config,
    proofServerUri,
    providers: {
      privateStateProvider: inMemoryPrivateStateProvider(),
      // Pass the browser's native WebSocket explicitly: the package's
      // default (node `ws` via isomorphic-ws) is undefined in browsers.
      publicDataProvider: indexerPublicDataProvider(
        config.indexerUri,
        config.indexerWsUri,
        window.WebSocket as never,
      ),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(proofServerUri, zkConfigProvider),
      walletProvider,
      midnightProvider,
    },
  };
}
