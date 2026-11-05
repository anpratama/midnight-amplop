import { describe, expect, it } from 'vitest';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../src/managed/AmplopAuction/contract/index.js';

// Amplop simulator tests: sealed-bid FIRST-PRICE auctions — lifecycle,
// in-contract time windows, eligibility, tie and forfeit rules, receipts.
//
// Block time is INJECTED per circuit call (the simulator's
// createCircuitContext takes an optional time, in seconds since the
// epoch), so tests can place each call at an exact point relative to an
// auction's commit/reveal deadlines — no sleeping, no wall clock.

type PrivateState = { secretKey: Uint8Array };

const COIN = '0'.repeat(64);
const ADDR = RT.sampleContractAddress();
const SELLER_A = key(99);
const SELLER_B = key(77);
const ITEM = key(7); // stands in for an item-descriptor hash

// Fixed timeline anchor (seconds). All deadlines derive from it.
const T0 = 1_900_000_000n;
const COMMIT_END = T0 + 1_000n; // commit window: blockTime < COMMIT_END
const REVEAL_END = T0 + 2_000n; // reveal window: COMMIT_END <= t < REVEAL_END
const COMMIT_T = T0 + 500n; // comfortably inside the commit window
const REVEAL_T = T0 + 1_500n; // comfortably inside the reveal window
const AFTER = T0 + 2_500n; // after the reveal deadline

const RESERVE = 100n;
const DEPOSIT = 10n;

function key(n: number): Uint8Array {
  const a = new Uint8Array(32);
  a[31] = n;
  return a;
}

// Per-bid one-time secrets (salts). Distinct from bidder identity keys.
const salt = (n: number) => key(100 + n);

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const witnesses = {
  localSecretKey: ({ privateState }: any): [any, Uint8Array] => [
    privateState,
    (privateState as PrivateState).secretKey,
  ],
};

/** Deploy a fresh registry and return circuit callers sharing one ledger. */
function deploy() {
  const contract = new Contract(witnesses);
  const ctor = contract.initialState(
    RT.createConstructorContext({ secretKey: SELLER_A }, COIN),
  );
  let state: any = (ctor.currentContractState as any).data;
  const ctxFor = (secretKey: Uint8Array, time: bigint) =>
    RT.createCircuitContext(ADDR, COIN, state, { secretKey }, undefined, undefined, Number(time));
  const advance = (r: any) => {
    state = r.context.currentQueryContext.state;
    return r;
  };
  const createAuction = (
    sellerSecret: Uint8Array,
    reserve: bigint,
    deposit: bigint,
    commitEnd: bigint,
    revealEnd: bigint,
    time: bigint,
  ): Uint8Array => {
    const r = advance(
      contract.impureCircuits.createAuction(
        ctxFor(sellerSecret, time),
        ITEM,
        reserve,
        deposit,
        commitEnd,
        revealEnd,
        sellerSecret,
      ),
    );
    return r.result as Uint8Array;
  };
  const commitBid = (bidder: Uint8Array, auctionId: Uint8Array, amount: bigint, secret: Uint8Array, time: bigint) =>
    advance(contract.impureCircuits.commitBid(ctxFor(bidder, time), auctionId, amount, secret));
  const revealBid = (bidder: Uint8Array, auctionId: Uint8Array, amount: bigint, secret: Uint8Array, time: bigint) =>
    advance(contract.impureCircuits.revealBid(ctxFor(bidder, time), auctionId, amount, secret));
  const finalize = (caller: Uint8Array, auctionId: Uint8Array, sellerSecret: Uint8Array, time: bigint) => {
    const r = advance(contract.impureCircuits.finalize(ctxFor(caller, time), auctionId, sellerSecret));
    return r.result as Uint8Array;
  };
  const verifyReceipt = (
    auctionId: Uint8Array,
    winningBid: bigint,
    committed: bigint,
    revealed: bigint,
    time: bigint,
  ): boolean => {
    const r = contract.impureCircuits.verifyReceipt(
      ctxFor(SELLER_A, time),
      auctionId,
      winningBid,
      committed,
      revealed,
    );
    return r.result as boolean;
  };
  const getHighestBid = (auctionId: Uint8Array, time: bigint): bigint => {
    const r = contract.impureCircuits.getHighestBid(ctxFor(SELLER_A, time), auctionId);
    return r.result as bigint;
  };
  const view = () => ledger(state);
  const info = (auctionId: Uint8Array) => view().auctions.lookup(auctionId);
  return { createAuction, commitBid, revealBid, finalize, verifyReceipt, getHighestBid, view, info };
}

/** Create the default auction: reserve 100, deposit 10, seller A. */
function defaultAuction(r: ReturnType<typeof deploy>): Uint8Array {
  return r.createAuction(SELLER_A, RESERVE, DEPOSIT, COMMIT_END, REVEAL_END, T0);
}

describe('Amplop — creating auctions', () => {
  it('publishes the auction definition and returns an auction id', () => {
    const r = deploy();
    const id = defaultAuction(r);
    expect(id).toHaveLength(32);
    expect(r.view().auctionCount).toBe(1n);
    const info = r.info(id);
    expect(toHex(info.itemHash)).toBe(toHex(ITEM));
    expect(info.reservePrice).toBe(RESERVE);
    expect(info.depositAmount).toBe(DEPOSIT);
    expect(info.commitDeadline).toBe(COMMIT_END);
    expect(info.revealDeadline).toBe(REVEAL_END);
    expect(info.finalized).toBe(false);
    expect(info.committedCount).toBe(0n);
    expect(info.revealedCount).toBe(0n);
    expect(info.hasLeader).toBe(false);
    expect(info.hasWinner).toBe(false);
    // the seller's raw secret never appears on the ledger, only its hash
    expect(info.sellerId).toHaveLength(32);
    expect(toHex(info.sellerId)).not.toBe(toHex(SELLER_A));
  });

  it('rejects invalid auction definitions', () => {
    const r = deploy();
    expect(() => r.createAuction(SELLER_A, RESERVE, DEPOSIT, REVEAL_END, COMMIT_END, T0)).toThrow(
      /Commit deadline must be before reveal deadline/,
    );
    expect(() => r.createAuction(SELLER_A, RESERVE, DEPOSIT, COMMIT_END, COMMIT_END, T0)).toThrow(
      /Commit deadline must be before reveal deadline/,
    );
    expect(() => r.createAuction(SELLER_A, RESERVE, 0n, COMMIT_END, REVEAL_END, T0)).toThrow(
      /Deposit must be positive/,
    );
    expect(r.view().auctionCount).toBe(0n);
  });

  it('gives distinct ids to auctions by the same seller', () => {
    const r = deploy();
    const a = defaultAuction(r);
    const b = r.createAuction(SELLER_A, 50n, 5n, COMMIT_END, REVEAL_END, T0);
    expect(toHex(a)).not.toBe(toHex(b));
    expect(r.view().auctionCount).toBe(2n);
  });
});

describe('Amplop — commit phase (the sealed envelope)', () => {
  it('records a commitment and the deposit, never the amount', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_T);
    const info = r.info(a);
    expect(info.committedCount).toBe(1n);
    expect(r.view().commitments.size()).toBe(1n);
    // the stored commitment is an opaque 32-byte hash — not the amount,
    // not the secret, not the bidder's key
    const [commitment] = [...r.view().commitments].map(([, c]) => c);
    expect(commitment).toHaveLength(32);
    expect(toHex(commitment)).not.toBe(toHex(salt(1)));
    expect(toHex(commitment)).not.toBe(toHex(key(1)));
    // the fixed deposit is accounted against the bid
    const depositValues = [...r.view().deposits].map(([, d]) => d);
    expect(depositValues).toEqual([DEPOSIT]);
    // nothing revealed yet
    expect(r.view().revealedBids.isEmpty()).toBe(true);
    expect(r.getHighestBid(a, COMMIT_T)).toBe(0n);
  });

  it('two bidders sealing the same amount produce unlinkable commitments', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_T);
    r.commitBid(key(2), a, 250n, salt(2), COMMIT_T);
    const commits = [...r.view().commitments].map(([, c]) => toHex(c));
    expect(new Set(commits).size).toBe(2);
    expect(r.info(a).committedCount).toBe(2n);
  });

  it('rejects a duplicate commitment from the same bidder', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_T);
    expect(() => r.commitBid(key(1), a, 300n, salt(9), COMMIT_T)).toThrow(/Already committed/);
    expect(r.info(a).committedCount).toBe(1n);
  });

  it('rejects a zero bid', () => {
    const r = deploy();
    const a = defaultAuction(r);
    expect(() => r.commitBid(key(1), a, 0n, salt(1), COMMIT_T)).toThrow(/Bid must be positive/);
  });

  it('rejects commits to a nonexistent auction', () => {
    const r = deploy();
    expect(() => r.commitBid(key(1), key(42), 250n, salt(1), COMMIT_T)).toThrow(/No such auction/);
  });

  it('accepts a commit at the last valid instant and rejects at the deadline', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_END - 1n);
    expect(() => r.commitBid(key(2), a, 250n, salt(2), COMMIT_END)).toThrow(
      /Commit window has closed/,
    );
    expect(() => r.commitBid(key(2), a, 250n, salt(2), COMMIT_END + 500n)).toThrow(
      /Commit window has closed/,
    );
    expect(r.info(a).committedCount).toBe(1n);
  });
});

describe('Amplop — reveal phase (opening the envelopes)', () => {
  it('rejects reveals before the reveal window opens', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_T);
    expect(() => r.revealBid(key(1), a, 250n, salt(1), COMMIT_T)).toThrow(
      /Reveal window has not opened/,
    );
    expect(() => r.revealBid(key(1), a, 250n, salt(1), COMMIT_END - 1n)).toThrow(
      /Reveal window has not opened/,
    );
  });

  it('rejects a reveal with the wrong secret', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_T);
    expect(() => r.revealBid(key(1), a, 250n, salt(2), REVEAL_T)).toThrow(
      /Reveal does not match commitment/,
    );
    expect(r.info(a).revealedCount).toBe(0n);
  });

  it('rejects a reveal whose amount differs from the sealed bid', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_T);
    expect(() => r.revealBid(key(1), a, 251n, salt(1), REVEAL_T)).toThrow(
      /Reveal does not match commitment/,
    );
  });

  it('rejects a reveal from a bidder who never committed', () => {
    const r = deploy();
    const a = defaultAuction(r);
    expect(() => r.revealBid(key(5), a, 250n, salt(5), REVEAL_T)).toThrow(/No bid to reveal/);
  });

  it('rejects a double reveal', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_T);
    r.revealBid(key(1), a, 250n, salt(1), REVEAL_T);
    expect(() => r.revealBid(key(1), a, 250n, salt(1), REVEAL_T)).toThrow(/Already revealed/);
    expect(r.info(a).revealedCount).toBe(1n);
  });

  it('rejects reveals at and after the reveal deadline', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_T);
    expect(() => r.revealBid(key(1), a, 250n, salt(1), REVEAL_END)).toThrow(
      /Reveal window has closed/,
    );
    expect(() => r.revealBid(key(1), a, 250n, salt(1), AFTER)).toThrow(/Reveal window has closed/);
  });

  it('accepts a reveal exactly at the start of the reveal window', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_T);
    r.revealBid(key(1), a, 250n, salt(1), COMMIT_END); // first reveal instant
    expect(r.info(a).revealedCount).toBe(1n);
    expect(r.getHighestBid(a, REVEAL_T)).toBe(250n);
  });
});

describe('Amplop — first-price outcome', () => {
  it('runs the full lifecycle: highest revealed bid wins and pays its own bid', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 150n, salt(1), COMMIT_T);
    r.commitBid(key(2), a, 300n, salt(2), COMMIT_T);
    r.commitBid(key(3), a, 200n, salt(3), COMMIT_T);
    r.revealBid(key(1), a, 150n, salt(1), REVEAL_T);
    expect(r.getHighestBid(a, REVEAL_T)).toBe(150n);
    r.revealBid(key(2), a, 300n, salt(2), REVEAL_T);
    expect(r.getHighestBid(a, REVEAL_T)).toBe(300n);
    r.revealBid(key(3), a, 200n, salt(3), REVEAL_T);
    expect(r.getHighestBid(a, REVEAL_T)).toBe(300n); // lower reveal never displaces

    const leaderBefore = r.info(a).leaderId;
    const receipt = r.finalize(SELLER_A, a, SELLER_A, AFTER);
    const info = r.info(a);
    expect(info.finalized).toBe(true);
    expect(info.hasWinner).toBe(true);
    // FIRST-PRICE: the amount due is the winner's own bid, in full
    expect(info.winningBid).toBe(300n);
    expect(info.winnerId).toEqual(leaderBefore);
    expect(info.forfeitedCount).toBe(0n);
    expect(info.forfeitedAmount).toBe(0n);
    expect(toHex(r.view().receipts.lookup(a))).toBe(toHex(receipt));
    expect(r.verifyReceipt(a, 300n, 3n, 3n, AFTER)).toBe(true);
  });

  it('settles a tie in favour of the first revealed bid', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_T);
    r.commitBid(key(2), a, 250n, salt(2), COMMIT_T);
    r.revealBid(key(1), a, 250n, salt(1), REVEAL_T);
    const firstLeader = r.info(a).leaderId;
    r.revealBid(key(2), a, 250n, salt(2), REVEAL_T);
    // the equal second reveal does NOT displace the first leader
    expect(r.info(a).leaderId).toEqual(firstLeader);
    r.finalize(SELLER_A, a, SELLER_A, AFTER);
    const info = r.info(a);
    expect(info.winningBid).toBe(250n);
    expect(info.winnerId).toEqual(firstLeader);
    expect(r.verifyReceipt(a, 250n, 2n, 2n, AFTER)).toBe(true);
  });

  it('records a below-reserve reveal as ineligible, not a crash', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 80n, salt(1), COMMIT_T); // below the 100 reserve
    r.commitBid(key(2), a, 500n, salt(2), COMMIT_T);
    r.revealBid(key(1), a, 80n, salt(1), REVEAL_T); // reveals fine...
    expect(r.info(a).revealedCount).toBe(1n); // ...and counts as revealed
    expect(r.info(a).hasLeader).toBe(false); // ...but cannot lead
    expect(r.getHighestBid(a, REVEAL_T)).toBe(0n);
    r.revealBid(key(2), a, 500n, salt(2), REVEAL_T);
    r.finalize(SELLER_A, a, SELLER_A, AFTER);
    expect(r.info(a).winningBid).toBe(500n);
    expect(r.verifyReceipt(a, 500n, 2n, 2n, AFTER)).toBe(true);
  });

  it('an auction whose only reveal is below reserve ends with no winner', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 50n, salt(1), COMMIT_T);
    r.revealBid(key(1), a, 50n, salt(1), REVEAL_T);
    r.finalize(SELLER_A, a, SELLER_A, AFTER);
    const info = r.info(a);
    expect(info.hasWinner).toBe(false);
    expect(info.winningBid).toBe(0n);
    expect(info.forfeitedCount).toBe(0n); // revealing never forfeits
    // the honest no-winner receipt verifies with a 0 winning bid
    expect(r.verifyReceipt(a, 0n, 1n, 1n, AFTER)).toBe(true);
  });

  it('finalizes an auction with no bids at all as a no-winner auction', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.finalize(SELLER_A, a, SELLER_A, AFTER);
    const info = r.info(a);
    expect(info.finalized).toBe(true);
    expect(info.hasWinner).toBe(false);
    expect(info.winningBid).toBe(0n);
    expect(info.forfeitedCount).toBe(0n);
    expect(info.forfeitedAmount).toBe(0n);
    expect(r.verifyReceipt(a, 0n, 0n, 0n, AFTER)).toBe(true);
  });
});

describe('Amplop — finalize rules and forfeits', () => {
  it('rejects finalizing before the reveal deadline', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 250n, salt(1), COMMIT_T);
    expect(() => r.finalize(SELLER_A, a, SELLER_A, REVEAL_T)).toThrow(
      /Reveal window is still open/,
    );
    expect(() => r.finalize(SELLER_A, a, SELLER_A, REVEAL_END - 1n)).toThrow(
      /Reveal window is still open/,
    );
  });

  it('only the seller can finalize', () => {
    const r = deploy();
    const a = defaultAuction(r);
    expect(() => r.finalize(SELLER_B, a, SELLER_B, AFTER)).toThrow(/Not the seller/);
    expect(() => r.finalize(SELLER_A, a, SELLER_B, AFTER)).toThrow(/Not the seller/);
    r.finalize(SELLER_A, a, SELLER_A, AFTER);
    expect(r.info(a).finalized).toBe(true);
  });

  it('rejects finalizing twice', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.finalize(SELLER_A, a, SELLER_A, AFTER);
    expect(() => r.finalize(SELLER_A, a, SELLER_A, AFTER)).toThrow(/Auction is already finalized/);
  });

  it('forfeits the deposits of bidders who never reveal', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 150n, salt(1), COMMIT_T);
    r.commitBid(key(2), a, 300n, salt(2), COMMIT_T);
    r.commitBid(key(3), a, 200n, salt(3), COMMIT_T);
    r.revealBid(key(1), a, 150n, salt(1), REVEAL_T);
    r.revealBid(key(2), a, 300n, salt(2), REVEAL_T);
    // bidder 3 never reveals
    r.finalize(SELLER_A, a, SELLER_A, AFTER);
    const info = r.info(a);
    expect(info.winningBid).toBe(300n);
    expect(info.forfeitedCount).toBe(1n);
    expect(info.forfeitedAmount).toBe(DEPOSIT); // 1 forfeited x 10 deposit, to the seller
    // the receipt honestly binds 3 committed / 2 revealed
    expect(r.verifyReceipt(a, 300n, 3n, 2n, AFTER)).toBe(true);
    expect(() => r.verifyReceipt(a, 300n, 3n, 3n, AFTER)).toThrow(/Reveal count does not match/);
  });

  it('forfeits every deposit when nobody reveals', () => {
    const r = deploy();
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 150n, salt(1), COMMIT_T);
    r.commitBid(key(2), a, 300n, salt(2), COMMIT_T);
    r.finalize(SELLER_A, a, SELLER_A, AFTER);
    const info = r.info(a);
    expect(info.hasWinner).toBe(false);
    expect(info.forfeitedCount).toBe(2n);
    expect(info.forfeitedAmount).toBe(2n * DEPOSIT);
    expect(r.verifyReceipt(a, 0n, 2n, 0n, AFTER)).toBe(true);
  });
});

describe('Amplop — outcome receipts', () => {
  /** Run a finalized auction: bids 150/300, both revealed, winner 300. */
  function finalizedAuction(r: ReturnType<typeof deploy>) {
    const a = defaultAuction(r);
    r.commitBid(key(1), a, 150n, salt(1), COMMIT_T);
    r.commitBid(key(2), a, 300n, salt(2), COMMIT_T);
    r.revealBid(key(1), a, 150n, salt(1), REVEAL_T);
    r.revealBid(key(2), a, 300n, salt(2), REVEAL_T);
    const receipt = r.finalize(SELLER_A, a, SELLER_A, AFTER);
    return { a, receipt };
  }

  it('rejects verification of a forged winning bid', () => {
    const r = deploy();
    const { a } = finalizedAuction(r);
    expect(() => r.verifyReceipt(a, 301n, 2n, 2n, AFTER)).toThrow(
      /Winning bid does not match the ledger/,
    );
    expect(() => r.verifyReceipt(a, 150n, 2n, 2n, AFTER)).toThrow(
      /Winning bid does not match the ledger/,
    );
  });

  it('rejects verification with inflated counts', () => {
    const r = deploy();
    const { a } = finalizedAuction(r);
    expect(() => r.verifyReceipt(a, 300n, 3n, 2n, AFTER)).toThrow(/Commit count does not match/);
    expect(() => r.verifyReceipt(a, 300n, 2n, 3n, AFTER)).toThrow(/Reveal count does not match/);
  });

  it('rejects verification before the auction is finalized', () => {
    const r = deploy();
    const a = defaultAuction(r);
    expect(() => r.verifyReceipt(a, 0n, 0n, 0n, AFTER)).toThrow(/Auction is not finalized/);
  });

  it('an outcome from one auction does not verify against another', () => {
    const r = deploy();
    const { a } = finalizedAuction(r);
    const b = r.createAuction(SELLER_B, 10n, 5n, COMMIT_END, REVEAL_END, T0);
    r.finalize(SELLER_B, b, SELLER_B, AFTER); // no bids on B
    expect(r.verifyReceipt(b, 0n, 0n, 0n, AFTER)).toBe(true);
    // auction A's outcome presented as auction B's is a forgery
    expect(() => r.verifyReceipt(b, 300n, 2n, 2n, AFTER)).toThrow(
      /Winning bid does not match the ledger/,
    );
    expect(toHex(a)).not.toBe(toHex(b));
  });
});

describe('Amplop — multi-auction independence', () => {
  it('keeps bids, phases and outcomes fully separate between auctions', () => {
    const r = deploy();
    const a = defaultAuction(r);
    const b = r.createAuction(SELLER_B, 50n, 5n, COMMIT_END, REVEAL_END, T0);

    // the same bidder may bid in both auctions — no cross-auction error
    r.commitBid(key(1), a, 150n, salt(1), COMMIT_T);
    r.commitBid(key(1), b, 60n, salt(1), COMMIT_T);
    r.commitBid(key(2), a, 300n, salt(2), COMMIT_T);
    expect(r.info(a).committedCount).toBe(2n);
    expect(r.info(b).committedCount).toBe(1n);
    expect(r.view().commitments.size()).toBe(3n);

    // revealing in B tallies only in B
    r.revealBid(key(1), b, 60n, salt(1), REVEAL_T);
    expect(r.info(b).revealedCount).toBe(1n);
    expect(r.info(a).revealedCount).toBe(0n);
    expect(r.getHighestBid(b, REVEAL_T)).toBe(60n);
    expect(r.getHighestBid(a, REVEAL_T)).toBe(0n);

    // finalizing A does not finalize B
    r.revealBid(key(1), a, 150n, salt(1), REVEAL_T);
    r.revealBid(key(2), a, 300n, salt(2), REVEAL_T);
    r.finalize(SELLER_A, a, SELLER_A, AFTER);
    expect(r.info(a).finalized).toBe(true);
    expect(r.info(b).finalized).toBe(false);
    r.finalize(SELLER_B, b, SELLER_B, AFTER);
    expect(r.info(a).winningBid).toBe(300n);
    expect(r.info(b).winningBid).toBe(60n);
    expect(r.verifyReceipt(a, 300n, 2n, 2n, AFTER)).toBe(true);
    expect(r.verifyReceipt(b, 60n, 1n, 1n, AFTER)).toBe(true);
  });
});
