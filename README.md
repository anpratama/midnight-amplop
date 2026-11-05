# Amplop — sealed-bid auctions on Midnight

**Sealed-bid auctions on Midnight — your bid stays in the envelope until reveal day.**

An entry for the **Midnight Buildathon** (AKINDO). *Amplop* is Indonesian
for "envelope": in a sealed-bid auction every bid goes into an envelope
that nobody — not the seller, not rival bidders — can peek into while the
auction runs. Amplop replaces the paper envelope with a zero-knowledge
commitment on Midnight, and replaces trust in the auctioneer with a
receipt anyone can verify.

## Why sealed bids?

In an ordinary on-chain auction every bid is public the moment it is
placed. That leaks each bidder's valuation, invites last-second sniping,
and lets the seller (or a friend) shill-bid against real participants.
Amplop keeps every bid sealed until the reveal window, then proves the
outcome:

- **Commit** — bids are hash commitments; the ledger sees *that* you bid,
  never *how much*.
- **Reveal** — each bidder opens their own envelope; the contract checks
  the opening against the sealed commitment.
- **Finalize** — the highest eligible revealed bid wins, and a receipt
  hash binds the result to the auction's parameters and counts.

## The rules (stated plainly)

- **First-price.** The highest eligible revealed bid wins, and the winner
  pays **exactly their own bid** — no second-price discount, no hidden
  fees in the contract.
- **Reserve.** A revealed bid below the auction's reserve price is
  *ineligible*: it is recorded as revealed (so the bidder is safe), but
  it cannot win.
- **Ties.** The first revealed of two equal highest bids wins. A later
  equal bid never displaces the leader.
- **Deposits.** Every bid records the auction's fixed deposit. Revealing —
  even below the reserve — never forfeits. A bidder who commits and never
  reveals forfeits the full deposit to the seller.
- **Losing bids stay sealed.** A bid that is never revealed is never
  opened: its amount remains known only to the bidder who placed it.

## How it works

One deployment of `AmplopAuction` is a **registry hosting any number of
independent auctions** — each with its own seller, item, reserve, deposit
and deadlines. State for one bidder in one auction is keyed by a one-way
hash of `(auctionId, bidderId)`, so auctions cannot interfere, and a
bidder's envelopes in different auctions are unlinkable.

| Phase | Circuit | Window (proven in-circuit) | What happens |
|---|---|---|---|
| Create | `createAuction` | — | Seller registers an item descriptor hash, reserve price, deposit, commit & reveal deadlines. |
| Commit | `commitBid` | `blockTime < commitDeadline` | Bidder seals `hash(amount, secret, bidder, auction)`; the fixed deposit is recorded against the bid. One envelope per bidder per auction. |
| Reveal | `revealBid` | `commitDeadline ≤ blockTime < revealDeadline` | Bidder opens `(amount, secret)`; the contract re-derives the commitment and rejects mismatches. Eligible reveals update the running highest bid. |
| Finalize | `finalize` | `blockTime ≥ revealDeadline` | Seller only. Winner = highest eligible revealed bid, amount due = that bid (first-price). Unrevealed deposits are counted as forfeits to the seller. Stores the outcome receipt. |
| Verify | `verifyReceipt` | any time after finalize | Re-derives the winning bid and counts from the ledger and checks a presented outcome against the stored receipt. Forgeries fail. |

### The clock problem, honestly

Compact circuits cannot *read* the current time — the standard library
only offers comparisons against block time (`blockTimeLt/Gte`, seconds
since the epoch). So deadlines live on the ledger and each phase **proves
its relation to the deadline inside the circuit**, rather than the UI
checking a clock. A consequence: `createAuction` can only enforce
`commitDeadline < revealDeadline`; it cannot prove a deadline is in the
future, because the contract has no "now" to compare with.

### The highest-bid problem, honestly

Compact circuits cannot iterate a Map, so the contract cannot rescan all
revealed bids at finalize time. The running highest eligible bid is
therefore updated **in-circuit at each reveal** — which is also what makes
the tie rule exact: taking the lead requires a *strictly greater* bid.
`verifyReceipt` re-derives the outcome from these ledger counters plus
the receipt hash, the same values `finalize` used.

## Privacy boundary (Midnight dual-ledger model)

| Data | Private or public | Where it lives | Why |
|---|---|---|---|
| Bidder's secret key | Private | `witness localSecretKey()`, on the bidder's device | Identity that never leaves the device |
| Bid amount (before reveal) | Private | circuit argument | The secret being protected; proven in ZK |
| Per-bid secret salt | Private | bidder's device | Hides the amount inside the commitment; losing it means the envelope can never be opened (and the deposit is forfeited) |
| Bidder / seller id | Public (hash) | `ledger` | One-way hash of the secret key; verifies the participant without exposing the key |
| Auction definition (item hash, reserve, deposit, deadlines) | Public | `ledger` | Everyone must see the rules; immutable once created |
| Commitments | Public (opaque hash) | `ledger` map | Binds each bidder to one sealed bid; prevents double-bidding and bid-switching |
| Deposits | Public (accounting) | `ledger` map | Fixed per auction; recorded against each commitment |
| Revealed amounts | Public, after reveal | `ledger` map | A reveal is a public opening — the envelope is opened by its owner, in the open |
| Highest bid, leader id (hash), counts | Public | `ledger` | Liveness and outcome tracking without naming non-winners |
| Final result + receipt | Public | `ledger` | Portable, verifiable evidence of the outcome |

Private values cross into public positions only through `disclose()` at
the exact moments the protocol intends (a reveal, a result) — exactly as
the compiler's privacy boundary requires.

## Why Midnight

Sealed-bid auctions are a natural fit for Midnight's dual ledger: the
*bid itself* is exactly the kind of data that must stay private while its
*existence, ordering and outcome* must be publicly verifiable. Compact's
commitments and selective disclosure let the contract prove "this reveal
matches that sealed bid" and "this winner really placed the highest
eligible bid" without ever putting an unrevealed bid on the public
ledger — something a transparent chain cannot offer without an external
commit-reveal bolt-on and full amount exposure at reveal for everyone.

## Use cases

- **NFT and domain sales** — collectors bid their real valuation without
  signalling it to rivals or snipers.
- **DAO treasury sales** — a DAO sells an asset without revealing its
  reserve strategy or letting insiders front-run the bids; the receipt
  is public evidence the sale was fair.
- **Scarce-slot allocation** — whitelist spots, validator slots, event
  capacity: allocated to the highest sealed bids, with losing bids never
  exposed.
- **Procurement** — suppliers submit sealed quotes; only the winner's
  price becomes part of the public record.

## Honest status

- **Phase 1 (this repo): contract + simulator tests.** The full lifecycle
  and every rule above are proven in the Midnight ledger simulator
  against the real compiled circuits: **31 simulator tests, all passing**
  (lifecycle, window boundaries, wrong-secret and wrong-amount reveals,
  double commit/reveal, below-reserve ineligibility, tie rule, no-bid and
  no-reveal auctions, forfeit accounting, forged receipts, multi-auction
  independence).
- **Phase 2 (this repo): frontend demo.** A Vite + React app in
  `frontend/` drives the same compiled circuits through the in-browser
  ledger simulator — the full lifecycle (create → commit → reveal →
  finalize → verify receipt) runs against the real contract, with a
  clearly labelled demo clock supplying the block time the circuits
  prove deadlines against. Bid amounts and secrets stay in local
  (device) state; only commitments reach the simulated ledger.
- **Deposits and settlement are ledger accounting in the contract
  model.** The contract records deposits, forfeits and the winning
  amount due; moving real shielded tokens against those records is the
  preprod integration step, not simulated here.
- **Not yet deployed.** A preprod deployment (with the wallet steps it
  requires) is a later phase. No claim of a live deployment is made.

## Versions (pinned to the Midnight support matrix)

| Component | Version |
|---|---|
| Compact toolchain (`compactc`) | **0.31.1** (language 0.23.0, targets ledger 8) |
| `@midnight-ntwrk/compact-runtime` | **0.16.0** |
| TypeScript | 5.6.3 |
| Vitest | 2.1.8 |
| Networks | Preview / Preprod / Mainnet (all ledger 8) |

Do **not** use toolchain 0.34+/0.35+ here: they target ledger 9, which is
not deployed on any public Midnight network yet.

## Setup

Requirements: Node.js 20+, no Docker needed for compile + tests.

```bash
# 1. Install the pinned compiler (once, if not already installed)
./scripts/install-compactc.sh          # installs compactc 0.31.1

# 2. Install dependencies
npm install

# 3. Compile the contract -> src/managed/AmplopAuction
npm run compact

# 4. Run the simulator tests
npm test

# 5. Run the frontend demo (Phase 2)
cd frontend
npm install
npm run dev        # or: npm run build && npm run preview
```

## Project layout

```
contract/src/AmplopAuction.compact   the auction registry contract
src/managed/AmplopAuction/           compactc output (generated, committed)
test/amplop-auction.test.ts          simulator test suite (31 tests)
scripts/install-compactc.sh          pinned toolchain installer
frontend/                            Phase 2 demo (Vite + React + TS)
frontend/src/lib/auctionEngine.ts    simulator engine wrapping the contract
frontend/src/managed/                copy of the compiled contract for the web build
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
