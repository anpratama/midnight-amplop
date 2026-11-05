/**
 * AuctionEngine — drives the AmplopAuction Compact contract through
 * Midnight's in-process circuit simulator
 * (@midnight-ntwrk/compact-runtime), exactly the way the Phase 1 test
 * suite (test/amplop-auction.test.ts) drives it: same witnesses, same
 * circuit-context shape, same compiled circuits. Nothing here is mocked:
 * createAuction / commitBid / revealBid / finalize / verifyReceipt /
 * getHighestBid all execute for real against one registry deployment.
 *
 * Block time: Compact deadlines are proven against block time inside the
 * circuits, and the simulator accepts an injected time per circuit call
 * (the 7th argument of createCircuitContext, seconds since the epoch).
 * The engine therefore owns a demo clock — `blockTime` — which the UI
 * displays and advances explicitly. Every call is stamped with the
 * engine's current block time, so phases move only when the clock moves.
 *
 * Privacy, honestly: bid amounts and per-bid secrets live ONLY in this
 * engine's local maps (the bidder's device, in a real deployment). The
 * ledger ever sees a commitment hash, counts, and — after a reveal — the
 * revealed amount, exactly as the contract's privacy boundary describes.
 * Participant names are demo-local labels for locally generated secret
 * keys; the ledger only ever holds one-way hashes of those keys.
 */
import * as RT from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  ledger,
  type Ledger,
} from '../managed/AmplopAuction/contract/index.js';

export type { Ledger };

type PrivateState = { secretKey: Uint8Array };

const witnesses = {
  localSecretKey: ({ privateState }: any): [any, Uint8Array] => [
    privateState,
    (privateState as PrivateState).secretKey,
  ],
};

// Placeholder coin info for the simulated ledger (no real tokens move).
const COIN = '0'.repeat(64);
// Read-only circuits never touch the witness; a zero key is fine there.
const READ_KEY = new Uint8Array(32);

export function randomKey(): Uint8Array {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return a;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

export function shortHex(hex: string): string {
  return hex.length > 12 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** SHA-256 of a UTF-8 string, as 32 bytes (item descriptors, bid secrets). */
async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

/** Friendly rendering of contract assertion failures. */
export function circuitError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/"([^"]+)"\s*$/);
  if (m) return m[1];
  const m2 = msg.match(/Error:\s*(.+)$/);
  return (m2 ? m2[1] : msg).slice(0, 220);
}

export type AuctionPhase = 'commit' | 'reveal' | 'ended' | 'finalized';

export interface AuctionSnapshot {
  auctionId: string; // hex
  itemLabel: string;
  itemHash: string; // hex
  sellerName: string;
  sellerId: string; // hex (one-way hash of the seller's key)
  reservePrice: number;
  depositAmount: number;
  commitDeadline: number; // unix seconds (block time)
  revealDeadline: number; // unix seconds (block time)
  finalized: boolean;
  committedCount: number;
  revealedCount: number;
  hasLeader: boolean;
  /** Highest eligible revealed bid (contract's getHighestBid circuit). */
  highestBid: number;
  leaderId: string; // hex, '' when there is no leader
  /** Demo-local name of the current leader, if the engine saw the reveal. */
  leaderName: string | null;
  hasWinner: boolean;
  winningBid: number;
  winnerId: string; // hex, '' when there is no winner
  winnerName: string | null;
  forfeitedCount: number;
  forfeitedAmount: number;
  phase: AuctionPhase;
  receipt: string | null; // hex, once finalized
}

export interface MyBid {
  bidderName: string;
  amount: number;
  commitment: string; // hex
  revealed: boolean;
}

interface AuctionMeta {
  itemLabel: string;
  sellerName: string;
  sellerKey: Uint8Array;
}

interface BidRecord extends MyBid {
  auctionId: string;
  secret: Uint8Array;
  order: number;
}

export class AuctionEngine {
  private contract = new Contract(witnesses);
  private state: any = null;
  private readonly addr: string = RT.sampleContractAddress();
  /** The demo clock: block time (unix seconds) stamped on every call. */
  private clock: number = Math.floor(Date.now() / 1000);
  private participants = new Map<string, Uint8Array>(); // name -> secret key
  private metas = new Map<string, AuctionMeta>(); // auctionId hex -> meta
  private bids = new Map<string, BidRecord>(); // `${auctionId}|${name}` -> bid
  private reveals = new Map<string, Array<{ name: string; amount: number }>>();
  private orderCounter = 0;

  constructor() {
    const ctor = this.contract.initialState(
      RT.createConstructorContext({ secretKey: READ_KEY }, COIN),
    );
    this.state = (ctor.currentContractState as any).data;
  }

  get deployed(): boolean {
    return this.state !== null;
  }

  /* ---------------- demo clock ---------------- */

  getBlockTime(): number {
    return this.clock;
  }

  setBlockTime(sec: number): void {
    this.clock = Math.floor(sec);
  }

  advanceBy(seconds: number): number {
    this.clock += Math.floor(seconds);
    return this.clock;
  }

  /* ---------------- participants ---------------- */

  private keyFor(name: string): Uint8Array {
    const n = name.trim();
    let k = this.participants.get(n);
    if (!k) {
      k = randomKey();
      this.participants.set(n, k);
    }
    return k;
  }

  /* ---------------- simulator plumbing ---------------- */

  private ctxFor(secretKey: Uint8Array) {
    return RT.createCircuitContext(
      this.addr,
      COIN,
      this.state,
      { secretKey },
      undefined,
      undefined,
      this.clock,
    );
  }

  private commit(ctxResult: any): void {
    this.state = ctxResult.context.currentQueryContext.state;
  }

  private phaseOf(info: { finalized: boolean; commitDeadline: bigint; revealDeadline: bigint }): AuctionPhase {
    if (info.finalized) return 'finalized';
    if (this.clock < Number(info.commitDeadline)) return 'commit';
    if (this.clock < Number(info.revealDeadline)) return 'reveal';
    return 'ended';
  }

  /** Recompute the leader's demo-local name from locally observed reveals. */
  private leaderNameFor(auctionIdHex: string, reservePrice: number): string | null {
    const list = this.reveals.get(auctionIdHex) ?? [];
    let best = 0;
    let name: string | null = null;
    for (const r of list) {
      // Same rule as the contract: eligible, strictly greater takes the lead.
      if (r.amount >= reservePrice && r.amount > best) {
        best = r.amount;
        name = r.name;
      }
    }
    return name;
  }

  private snapshot(auctionIdHex: string): AuctionSnapshot {
    const l: Ledger = ledger(this.state);
    const idBytes = hexToBytes(auctionIdHex);
    const info = l.auctions.lookup(idBytes);
    let highest = info.hasLeader ? Number(info.highestBid) : 0;
    try {
      // Ask the contract itself — the same read the Phase 1 tests use.
      highest = Number(
        this.contract.impureCircuits.getHighestBid(this.ctxFor(READ_KEY), idBytes).result as bigint,
      );
    } catch {
      /* fall back to the raw ledger field */
    }
    const meta = this.metas.get(auctionIdHex);
    const leaderName = this.leaderNameFor(auctionIdHex, Number(info.reservePrice));
    return {
      auctionId: auctionIdHex,
      itemLabel: meta?.itemLabel ?? '(unknown item)',
      itemHash: toHex(info.itemHash),
      sellerName: meta?.sellerName ?? '(unknown seller)',
      sellerId: toHex(info.sellerId),
      reservePrice: Number(info.reservePrice),
      depositAmount: Number(info.depositAmount),
      commitDeadline: Number(info.commitDeadline),
      revealDeadline: Number(info.revealDeadline),
      finalized: info.finalized,
      committedCount: Number(info.committedCount),
      revealedCount: Number(info.revealedCount),
      hasLeader: info.hasLeader,
      highestBid: highest,
      leaderId: info.hasLeader ? toHex(info.leaderId) : '',
      leaderName: info.hasLeader ? leaderName : null,
      hasWinner: info.hasWinner,
      winningBid: Number(info.winningBid),
      winnerId: info.hasWinner ? toHex(info.winnerId) : '',
      winnerName: info.hasWinner ? leaderName : null,
      forfeitedCount: Number(info.forfeitedCount),
      forfeitedAmount: Number(info.forfeitedAmount),
      phase: this.phaseOf(info),
      receipt: l.receipts.member(idBytes) ? toHex(l.receipts.lookup(idBytes)) : null,
    };
  }

  /* ---------------- reads ---------------- */

  listAuctions(): AuctionSnapshot[] {
    const l: Ledger = ledger(this.state);
    return [...l.auctions].map(([id]) => this.snapshot(toHex(id)));
  }

  view(auctionIdHex: string): AuctionSnapshot {
    return this.snapshot(auctionIdHex);
  }

  /** This device's sealed envelopes in one auction (private, local only). */
  myBids(auctionIdHex: string): MyBid[] {
    return [...this.bids.values()]
      .filter((b) => b.auctionId === auctionIdHex)
      .sort((a, b) => a.order - b.order)
      .map(({ bidderName, amount, commitment, revealed }) => ({
        bidderName,
        amount,
        commitment,
        revealed,
      }));
  }

  /* ---------------- writes ---------------- */

  /**
   * Create an auction as `sellerName`. The item label is hashed locally
   * (SHA-256) — the ledger stores only that descriptor hash, exactly as
   * the contract intends. Deadlines are block-time seconds.
   */
  async createAuction(
    itemLabel: string,
    reservePrice: number,
    depositAmount: number,
    commitDeadline: number,
    revealDeadline: number,
    sellerName: string,
  ): Promise<AuctionSnapshot> {
    const sellerKey = this.keyFor(sellerName);
    const itemHash = await sha256(itemLabel);
    const r = this.contract.impureCircuits.createAuction(
      this.ctxFor(sellerKey),
      itemHash,
      BigInt(reservePrice),
      BigInt(depositAmount),
      BigInt(commitDeadline),
      BigInt(revealDeadline),
      sellerKey,
    );
    this.commit(r);
    const auctionId = toHex(r.result as Uint8Array);
    this.metas.set(auctionId, { itemLabel, sellerName: sellerName.trim(), sellerKey });
    return this.snapshot(auctionId);
  }

  /**
   * Seal a bid. `secretText` is hashed locally into the 32-byte salt; if
   * empty, a random salt is generated (and returned once, so the bidder
   * can keep it). Amount + salt stay in local private state — only the
   * commitment reaches the ledger.
   */
  async commitBid(
    auctionIdHex: string,
    bidderName: string,
    amount: number,
    secretText: string,
  ): Promise<{ snapshot: AuctionSnapshot; commitment: string; generatedSecret: string | null }> {
    const name = bidderName.trim();
    const bidderKey = this.keyFor(name);
    const generated = secretText.trim() === '';
    const secret = generated ? randomKey() : await sha256(secretText);
    const before = new Set([...ledger(this.state).commitments].map(([k]) => toHex(k)));
    const r = this.contract.impureCircuits.commitBid(
      this.ctxFor(bidderKey),
      hexToBytes(auctionIdHex),
      BigInt(amount),
      secret,
    );
    this.commit(r);
    let commitment = '';
    for (const [k, c] of ledger(this.state).commitments) {
      if (!before.has(toHex(k))) commitment = toHex(c);
    }
    const record: BidRecord = {
      auctionId: auctionIdHex,
      bidderName: name,
      amount,
      commitment,
      revealed: false,
      secret,
      order: this.orderCounter++,
    };
    this.bids.set(`${auctionIdHex}|${name}`, record);
    return {
      snapshot: this.snapshot(auctionIdHex),
      commitment,
      generatedSecret: generated ? toHex(secret) : null,
    };
  }

  /**
   * Open a sealed bid. With no overrides, the exact amount + secret from
   * the local private record are used. Overrides exist so the demo can
   * show the contract rejecting a mismatched opening.
   */
  async revealBid(
    auctionIdHex: string,
    bidderName: string,
    amountOverride?: number,
    secretTextOverride?: string,
  ): Promise<AuctionSnapshot> {
    const name = bidderName.trim();
    const record = this.bids.get(`${auctionIdHex}|${name}`);
    if (!record) throw new Error(`No sealed bid on this device for ${name}.`);
    const amount = amountOverride !== undefined ? amountOverride : record.amount;
    const secret =
      secretTextOverride !== undefined && secretTextOverride.trim() !== ''
        ? await sha256(secretTextOverride)
        : record.secret;
    const bidderKey = this.keyFor(name);
    const r = this.contract.impureCircuits.revealBid(
      this.ctxFor(bidderKey),
      hexToBytes(auctionIdHex),
      BigInt(amount),
      secret,
    );
    this.commit(r);
    record.revealed = true;
    const list = this.reveals.get(auctionIdHex) ?? [];
    list.push({ name, amount });
    this.reveals.set(auctionIdHex, list);
    return this.snapshot(auctionIdHex);
  }

  /** Finalize as the auction's seller (seller key is kept locally). */
  finalize(auctionIdHex: string): { snapshot: AuctionSnapshot; receipt: string } {
    const meta = this.metas.get(auctionIdHex);
    if (!meta) throw new Error('Unknown auction on this device.');
    const r = this.contract.impureCircuits.finalize(
      this.ctxFor(meta.sellerKey),
      hexToBytes(auctionIdHex),
      meta.sellerKey,
    );
    this.commit(r);
    return { snapshot: this.snapshot(auctionIdHex), receipt: toHex(r.result as Uint8Array) };
  }

  /**
   * Ask the contract to verify the auction's outcome against its stored
   * receipt, re-deriving the winning bid and counts from the ledger.
   */
  verifyReceipt(auctionIdHex: string): boolean {
    const snap = this.snapshot(auctionIdHex);
    const claimBid = snap.hasLeader ? snap.highestBid : 0;
    const r = this.contract.impureCircuits.verifyReceipt(
      this.ctxFor(READ_KEY),
      hexToBytes(auctionIdHex),
      BigInt(claimBid),
      BigInt(snap.committedCount),
      BigInt(snap.revealedCount),
    );
    return r.result as boolean;
  }
}
