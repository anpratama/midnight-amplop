import { useRef, useState } from 'react';
import {
  AuctionEngine,
  shortHex,
  circuitError,
  type AuctionSnapshot,
  type MyBid,
} from './lib/auctionEngine';

interface LogEntry {
  t: string;
  kind: 'ok' | 'err' | 'info';
  text: string;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 30));
const clockNow = () =>
  new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtTime = (sec: number) => new Date(sec * 1000).toLocaleString();
const toLocalInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (s: string) => Math.floor(new Date(s).getTime() / 1000);

const PHASE_LABEL: Record<AuctionSnapshot['phase'], string> = {
  commit: 'COMMIT OPEN',
  reveal: 'REVEAL OPEN',
  ended: 'ENDED',
  finalized: 'FINALIZED',
};

export default function App() {
  const engineRef = useRef<AuctionEngine | null>(null);
  if (!engineRef.current) engineRef.current = new AuctionEngine();
  const engine = engineRef.current;

  const [auctions, setAuctions] = useState<AuctionSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clock, setClock] = useState<number>(() => engine.getBlockTime());
  const [bump, setBump] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [lastCommitment, setLastCommitment] = useState<{ auctionId: string; hash: string } | null>(null);
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);

  // create-auction form
  const [sellerName, setSellerName] = useState('Sari');
  const [itemLabel, setItemLabel] = useState('Vintage film camera — Leica M6');
  const [reserve, setReserve] = useState('100');
  const [deposit, setDeposit] = useState('10');
  const [commitAt, setCommitAt] = useState(() =>
    toLocalInput(new Date((engine.getBlockTime() + 3600) * 1000)),
  );
  const [revealAt, setRevealAt] = useState(() =>
    toLocalInput(new Date((engine.getBlockTime() + 2 * 3600) * 1000)),
  );

  // bid form
  const [bidderName, setBidderName] = useState('Bima');
  const [bidAmount, setBidAmount] = useState('150');
  const [bidSecret, setBidSecret] = useState('');

  // reveal overrides, per bidder name
  const [revealEdits, setRevealEdits] = useState<Record<string, { amount: string; secret: string }>>({});

  const addLog = (kind: LogEntry['kind'], text: string) =>
    setLog((l) => [...l.slice(-60), { t: clockNow(), kind, text }]);

  const refresh = () => {
    setAuctions(engine.listAuctions());
    setClock(engine.getBlockTime());
    setBump((b) => b + 1);
  };

  const selected = auctions.find((a) => a.auctionId === selectedId) ?? null;
  // myBids is read from the engine's local private state; `bump` re-reads it.
  const myBids: MyBid[] = selected && bump >= 0 ? engine.myBids(selected.auctionId) : [];

  /* ---------------- actions ---------------- */

  const doCreate = async () => {
    const label = itemLabel.trim();
    const seller = sellerName.trim();
    const reservePrice = parseInt(reserve, 10);
    const depositAmount = parseInt(deposit, 10);
    const commitDeadline = fromLocalInput(commitAt);
    const revealDeadline = fromLocalInput(revealAt);
    if (!label) return setError('Give the item a label.');
    if (!seller) return setError('Give the seller a name.');
    if (Number.isNaN(reservePrice) || reservePrice < 0)
      return setError('Reserve price must be a number ≥ 0.');
    if (Number.isNaN(depositAmount) || depositAmount <= 0)
      return setError('Deposit must be a positive number.');
    if (!commitDeadline || !revealDeadline || commitDeadline >= revealDeadline)
      return setError('The commit deadline must be before the reveal deadline.');
    if (commitDeadline <= engine.getBlockTime())
      return setError('The commit deadline is not after the current block time — commits would be rejected. Move the deadline or the demo clock.');
    setBusy(true);
    setError(null);
    await tick();
    try {
      const snap = await engine.createAuction(
        label,
        reservePrice,
        depositAmount,
        commitDeadline,
        revealDeadline,
        seller,
      );
      setSelectedId(snap.auctionId);
      setVerify({});
      refresh();
      addLog(
        'ok',
        `Auction created by ${seller} — "${label}", reserve ${reservePrice}, deposit ${depositAmount}, commit until ${fmtTime(commitDeadline)}, reveal until ${fmtTime(revealDeadline)}.`,
      );
    } catch (e) {
      const m = circuitError(e);
      setError(m);
      addLog('err', `Create failed: ${m}`);
    } finally {
      setBusy(false);
    }
  };

  const doCommit = async () => {
    if (!selected) return;
    const name = bidderName.trim();
    const amount = parseInt(bidAmount, 10);
    if (!name) return setError('Give the bidder a name.');
    if (Number.isNaN(amount) || amount <= 0) return setError('Bid amount must be a positive number.');
    setBusy(true);
    setError(null);
    await tick();
    try {
      const res = await engine.commitBid(selected.auctionId, name, amount, bidSecret);
      setLastCommitment({ auctionId: selected.auctionId, hash: res.commitment });
      setGeneratedSecret(res.generatedSecret);
      refresh();
      addLog(
        'ok',
        `${name} sealed a bid in "${selected.itemLabel}" → commitment 0x${shortHex(res.commitment)}. The amount never left this device.`,
      );
    } catch (e) {
      const m = circuitError(e);
      setError(m);
      addLog('err', `Commit failed for ${name}: ${m}`);
    } finally {
      setBusy(false);
    }
  };

  const doReveal = async (bid: MyBid) => {
    if (!selected) return;
    const edit = revealEdits[bid.bidderName];
    const amountOverride =
      edit && edit.amount.trim() !== '' ? parseInt(edit.amount, 10) : undefined;
    const secretOverride = edit && edit.secret.trim() !== '' ? edit.secret : undefined;
    setBusy(true);
    setError(null);
    await tick();
    try {
      const snap = await engine.revealBid(
        selected.auctionId,
        bid.bidderName,
        amountOverride,
        secretOverride,
      );
      refresh();
      addLog(
        'ok',
        `${bid.bidderName} opened their envelope: ${amountOverride ?? bid.amount}. ` +
          (snap.hasLeader
            ? `Highest eligible bid is now ${snap.highestBid}${snap.leaderName ? ` (${snap.leaderName})` : ''}.`
            : 'No eligible leader yet.'),
      );
    } catch (e) {
      const m = circuitError(e);
      setError(m);
      addLog('err', `Reveal failed for ${bid.bidderName}: ${m}`);
    } finally {
      setBusy(false);
    }
  };

  const doFinalize = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    await tick();
    try {
      const { snapshot, receipt } = engine.finalize(selected.auctionId);
      refresh();
      addLog(
        'ok',
        snapshot.hasWinner
          ? `Finalized "${selected.itemLabel}" — winner ${snapshot.winnerName ?? '0x' + shortHex(snapshot.winnerId)} at ${snapshot.winningBid} (first-price: pays their own bid). Receipt 0x${shortHex(receipt)}.`
          : `Finalized "${selected.itemLabel}" — no winner. Receipt 0x${shortHex(receipt)}.`,
      );
    } catch (e) {
      const m = circuitError(e);
      setError(m);
      addLog('err', `Finalize failed: ${m}`);
    } finally {
      setBusy(false);
    }
  };

  const doVerify = async () => {
    if (!selected) return;
    setBusy(true);
    await tick();
    try {
      const ok = engine.verifyReceipt(selected.auctionId);
      setVerify((v) => ({
        ...v,
        [selected.auctionId]: {
          ok,
          text: ok
            ? 'PASS — the contract re-derived the winning bid and counts from the ledger and they match the stored receipt.'
            : 'FAIL — the outcome does not match the stored receipt.',
        },
      }));
      addLog(ok ? 'ok' : 'err', `Receipt verification for "${selected.itemLabel}": ${ok ? 'PASS' : 'FAIL'}.`);
    } catch (e) {
      const m = circuitError(e);
      setVerify((v) => ({ ...v, [selected.auctionId]: { ok: false, text: `FAIL — ${m}` } }));
      addLog('err', `Receipt verification failed: ${m}`);
    } finally {
      setBusy(false);
    }
  };

  const advance = (seconds: number, label: string) => {
    engine.advanceBy(seconds);
    refresh();
    addLog('info', `Demo clock advanced ${label} → block time ${fmtTime(engine.getBlockTime())}.`);
  };

  const skipToBoundary = () => {
    if (!selected) return;
    const target =
      selected.phase === 'commit'
        ? selected.commitDeadline
        : selected.phase === 'reveal'
          ? selected.revealDeadline
          : null;
    if (target === null) return;
    engine.setBlockTime(target);
    refresh();
    addLog('info', `Demo clock jumped to the phase boundary → ${fmtTime(target)}.`);
  };

  /* ---------------- render ---------------- */

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <h1>
            <span className="env">✉</span> Amplop
          </h1>
          <p className="tagline">
            Sealed-bid auctions on Midnight — your bid stays in the envelope until reveal day.
          </p>
        </div>
        <div className="badge">
          <span className="dot" /> Simulator demo — real compiled Compact circuits, in-browser
          ledger. Not a live deployment.
        </div>
      </header>

      <section className="clockbar card">
        <div className="clock-info">
          <div className="clock-label">DEMO CLOCK — block time used by the contract</div>
          <div className="clock-value">{fmtTime(clock)}</div>
          <div className="clock-note">
            Compact deadlines are proven against block time in-circuit. Time in this demo only
            moves when you move it.
          </div>
        </div>
        <div className="clock-actions">
          <button onClick={() => advance(600, '+10 minutes')}>+10 min</button>
          <button onClick={() => advance(3600, '+1 hour')}>+1 hour</button>
          <button onClick={() => advance(6 * 3600, '+6 hours')}>+6 hours</button>
          <button onClick={() => advance(24 * 3600, '+1 day')}>+1 day</button>
          {selected && (selected.phase === 'commit' || selected.phase === 'reveal') && (
            <button className="accent" onClick={skipToBoundary}>
              Skip to next phase boundary
            </button>
          )}
        </div>
      </section>

      <section className="card how">
        <h2>How it works</h2>
        <div className="phases">
          <div className="phase-step">
            <div className="step-num">1 · COMMIT</div>
            <p>
              Each bidder seals a bid: the ledger stores only a hash commitment plus the fixed
              deposit. Nobody — not the seller, not rivals — can see the amount.
            </p>
          </div>
          <div className="phase-step">
            <div className="step-num">2 · REVEAL</div>
            <p>
              After the commit deadline, each bidder opens their own envelope. The contract checks
              the opening against the sealed commitment; a mismatch is rejected.
            </p>
          </div>
          <div className="phase-step">
            <div className="step-num">3 · FINALIZE</div>
            <p>
              The seller finalizes. The highest eligible revealed bid wins; bidders who never
              revealed forfeit their deposit to the seller. A verifiable receipt is stored.
            </p>
          </div>
        </div>
        <div className="rules">
          <div>
            <h3>First-price rule</h3>
            <p>
              The winner pays <strong>exactly their own bid</strong> — no second-price discount.
              Bids below the reserve are recorded as revealed (deposit safe) but cannot win. Ties
              go to the first revealed of the equal highest bids.
            </p>
          </div>
          <div>
            <h3>Private vs public</h3>
            <p>
              <strong>Private:</strong> your amount and secret before reveal — they never leave
              this device. A bid that is never revealed stays sealed <em>forever</em>.{' '}
              <strong>Public:</strong> commitments, counts, deadlines, revealed amounts, the
              winner and the receipt.
            </p>
          </div>
        </div>
      </section>

      {error && <div className="error-banner">⚠ {error}</div>}

      <div className="layout">
        <div className="col">
          <section className="card">
            <h2>Create an auction</h2>
            <label>
              Seller name
              <input value={sellerName} onChange={(e) => setSellerName(e.target.value)} />
            </label>
            <label>
              Item label
              <input value={itemLabel} onChange={(e) => setItemLabel(e.target.value)} />
            </label>
            <div className="row">
              <label>
                Reserve price
                <input
                  type="number"
                  min="0"
                  value={reserve}
                  onChange={(e) => setReserve(e.target.value)}
                />
              </label>
              <label>
                Deposit per bid
                <input
                  type="number"
                  min="1"
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                />
              </label>
            </div>
            <label>
              Commit deadline
              <input
                type="datetime-local"
                value={commitAt}
                onChange={(e) => setCommitAt(e.target.value)}
              />
            </label>
            <label>
              Reveal deadline
              <input
                type="datetime-local"
                value={revealAt}
                onChange={(e) => setRevealAt(e.target.value)}
              />
            </label>
            <button className="primary" disabled={busy} onClick={doCreate}>
              Create auction
            </button>
            <p className="hint">
              Deadlines are compared against the demo clock above, in-circuit. The item label is
              hashed locally — the ledger stores only its hash.
            </p>
          </section>

          <section className="card">
            <h2>Auction board</h2>
            {auctions.length === 0 && (
              <p className="muted">No auctions yet. Create the first one above.</p>
            )}
            <div className="board">
              {auctions.map((a) => (
                <button
                  key={a.auctionId}
                  className={`auction-card ${a.auctionId === selectedId ? 'active' : ''}`}
                  onClick={() => setSelectedId(a.auctionId)}
                >
                  <div className="auction-top">
                    <span className="auction-item">{a.itemLabel}</span>
                    <span className={`phase phase-${a.phase}`}>{PHASE_LABEL[a.phase]}</span>
                  </div>
                  <div className="auction-meta">
                    Seller {a.sellerName} · reserve {a.reservePrice} · deposit {a.depositAmount}
                  </div>
                  <div className="auction-meta">
                    ✉ {a.committedCount} committed · 🔓 {a.revealedCount} revealed
                    {a.phase !== 'commit' && a.hasLeader && (
                      <> · highest {a.highestBid}{a.leaderName ? ` (${a.leaderName})` : ''}</>
                    )}
                  </div>
                  <div className="auction-meta dim">
                    commit ≤ {fmtTime(a.commitDeadline)} · reveal ≤ {fmtTime(a.revealDeadline)}
                  </div>
                </button>
              ))}
            </div>
          </section>
        </div>

        <div className="col">
          {selected ? (
            <section className="card detail">
              <div className="detail-head">
                <h2>{selected.itemLabel}</h2>
                <span className={`phase phase-${selected.phase}`}>
                  {PHASE_LABEL[selected.phase]}
                </span>
              </div>
              <div className="kv">
                <span>Seller</span>
                <b>
                  {selected.sellerName} <span className="dim">(id 0x{shortHex(selected.sellerId)})</span>
                </b>
                <span>Reserve / deposit</span>
                <b>
                  {selected.reservePrice} / {selected.depositAmount}
                </b>
                <span>Committed / revealed</span>
                <b>
                  {selected.committedCount} / {selected.revealedCount}
                </b>
                {(selected.phase === 'reveal' || selected.phase === 'ended') && (
                  <>
                    <span>Highest eligible bid</span>
                    <b>
                      {selected.hasLeader
                        ? `${selected.highestBid}${selected.leaderName ? ` — ${selected.leaderName}` : ''}`
                        : 'none yet'}
                    </b>
                  </>
                )}
                <span>Auction id</span>
                <b className="mono">0x{shortHex(selected.auctionId)}</b>
              </div>

              {selected.phase === 'commit' && (
                <div className="panel">
                  <h3>Seal a bid</h3>
                  <div className="row">
                    <label>
                      Bidder name
                      <input value={bidderName} onChange={(e) => setBidderName(e.target.value)} />
                    </label>
                    <label>
                      Amount
                      <input
                        type="number"
                        min="1"
                        value={bidAmount}
                        onChange={(e) => setBidAmount(e.target.value)}
                      />
                    </label>
                  </div>
                  <label>
                    Secret (optional — leave empty to generate one)
                    <input
                      value={bidSecret}
                      onChange={(e) => setBidSecret(e.target.value)}
                      placeholder="a phrase only you know"
                    />
                  </label>
                  <button className="primary" disabled={busy} onClick={doCommit}>
                    ✉ Seal this bid
                  </button>
                  {lastCommitment && lastCommitment.auctionId === selected.auctionId && (
                    <p className="hint mono">
                      On the ledger now: commitment 0x{shortHex(lastCommitment.hash)} — the amount
                      is not in there.
                    </p>
                  )}
                  {generatedSecret && (
                    <p className="warnbox">
                      A secret was generated for the last bid: <span className="mono">{generatedSecret}</span>
                      <br />
                      In this demo it is kept in local state for the reveal. Lose it in real life
                      and the envelope can never be opened — the deposit is forfeited.
                    </p>
                  )}
                </div>
              )}

              {myBids.length > 0 && (
                <div className="panel">
                  <h3>Envelopes sealed from this device</h3>
                  {myBids.map((bid) => {
                    const edit = revealEdits[bid.bidderName] ?? {
                      amount: String(bid.amount),
                      secret: '',
                    };
                    return (
                      <div key={bid.bidderName} className="envelope">
                        <div className="env-head">
                          <b>{bid.bidderName}</b>
                          <span className="mono dim">0x{shortHex(bid.commitment)}</span>
                          <span className={bid.revealed ? 'ok-text' : 'dim'}>
                            {bid.revealed ? `🔓 opened at ${bid.amount}` : '✉ still sealed'}
                          </span>
                        </div>
                        {!bid.revealed && selected.phase === 'reveal' && (
                          <div className="env-reveal">
                            <label>
                              Amount
                              <input
                                type="number"
                                value={edit.amount}
                                onChange={(e) =>
                                  setRevealEdits((m) => ({
                                    ...m,
                                    [bid.bidderName]: { ...edit, amount: e.target.value },
                                  }))
                                }
                              />
                            </label>
                            <label>
                              Secret override (optional)
                              <input
                                value={edit.secret}
                                placeholder="leave empty to use the sealed secret"
                                onChange={(e) =>
                                  setRevealEdits((m) => ({
                                    ...m,
                                    [bid.bidderName]: { ...edit, secret: e.target.value },
                                  }))
                                }
                              />
                            </label>
                            <button disabled={busy} onClick={() => doReveal(bid)}>
                              Open envelope
                            </button>
                          </div>
                        )}
                        {!bid.revealed && selected.phase === 'commit' && (
                          <p className="hint">Reveals open at {fmtTime(selected.commitDeadline)}.</p>
                        )}
                        {!bid.revealed && (selected.phase === 'ended' || selected.phase === 'finalized') && (
                          <p className="hint">
                            Never opened — this bid stays sealed forever and its deposit is
                            forfeited to the seller.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {selected.phase === 'reveal' && myBids.length === 0 && (
                <p className="hint">
                  The reveal window is open, but no bids were sealed from this device in this
                  auction.
                </p>
              )}

              {selected.phase === 'ended' && (
                <div className="panel">
                  <h3>Finalize</h3>
                  <p className="hint">
                    The reveal deadline has passed. The seller ({selected.sellerName}) can now
                    finalize: the highest eligible revealed bid wins and pays its own bid;
                    unrevealed deposits are forfeited to the seller.
                  </p>
                  <button className="primary" disabled={busy} onClick={doFinalize}>
                    Finalize as {selected.sellerName}
                  </button>
                </div>
              )}

              {selected.phase === 'finalized' && (
                <div className="panel result">
                  <h3>Result</h3>
                  {selected.hasWinner ? (
                    <p>
                      🏆 Winner:{' '}
                      <b>{selected.winnerName ?? `0x${shortHex(selected.winnerId)}`}</b> — winning
                      bid <b>{selected.winningBid}</b>. First-price: the winner pays exactly
                      their own bid, {selected.winningBid}.
                    </p>
                  ) : (
                    <p>No winner — no eligible bid was revealed at or above the reserve.</p>
                  )}
                  <p>
                    Forfeited deposits: <b>{selected.forfeitedAmount}</b> ({selected.forfeitedCount}{' '}
                    unrevealed bid{selected.forfeitedCount === 1 ? '' : 's'}) → to the seller.
                  </p>
                  <p className="mono break">Receipt: 0x{selected.receipt}</p>
                  <button disabled={busy} onClick={doVerify}>
                    ✓ Verify receipt
                  </button>
                  {verify[selected.auctionId] && (
                    <p className={verify[selected.auctionId].ok ? 'pass' : 'fail'}>
                      {verify[selected.auctionId].text}
                    </p>
                  )}
                </div>
              )}
            </section>
          ) : (
            <section className="card detail empty">
              <h2>No auction selected</h2>
              <p className="muted">
                Create an auction, seal a bid while the commit window is open, move the demo clock
                into the reveal window, open the envelopes, and finalize.
              </p>
            </section>
          )}

          <section className="card log">
            <h2>Activity</h2>
            {log.length === 0 && <p className="muted">Nothing yet.</p>}
            {log.map((e, i) => (
              <div key={i} className={`log-line log-${e.kind}`}>
                <span className="log-t">{e.t}</span> {e.text}
              </div>
            ))}
          </section>
        </div>
      </div>

      <footer className="footer">
        <p>
          Honest scope: this demo runs the real AmplopAuction circuits in Midnight's in-browser
          ledger simulator. Deposits, forfeits and the winning amount are contract ledger
          accounting — no real tokens move, and nothing is deployed to a live network. Losing
          bids that are never revealed stay sealed forever: their amounts exist only on the
          bidder's device.
        </p>
      </footer>
    </div>
  );
}
