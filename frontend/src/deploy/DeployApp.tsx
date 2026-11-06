import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildBrowserProviders,
  findLace,
  type BrowserProviders,
  type LaceConnectedApi,
} from './providers';
import { deployAmplop, smokeAmplop } from './engine';

const ADDRESS_KEY = 'amplop-preprod-contract-address';

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: 760,
    margin: '0 auto',
    padding: '24px 16px 48px',
    color: '#1a1a2e',
  },
  card: {
    border: '1px solid #d5d5e5',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    background: '#fafaff',
  },
  button: {
    padding: '10px 18px',
    borderRadius: 8,
    border: 'none',
    background: '#4b3fd6',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
    marginRight: 8,
  },
  buttonDisabled: {
    padding: '10px 18px',
    borderRadius: 8,
    border: 'none',
    background: '#a5a0c9',
    color: '#fff',
    fontWeight: 600,
    marginRight: 8,
  },
  log: {
    background: '#10101c',
    color: '#b7f7c3',
    fontFamily: 'ui-monospace, monospace',
    fontSize: 12.5,
    lineHeight: 1.55,
    borderRadius: 10,
    padding: 14,
    height: 340,
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  warn: {
    background: '#fff7e0',
    border: '1px solid #e8cf7a',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    fontSize: 14,
  },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: 13 },
};

export default function DeployApp() {
  const [laceFound] = useState(() => findLace() !== undefined);
  const [api, setApi] = useState<LaceConnectedApi | null>(null);
  const [bp, setBp] = useState<BrowserProviders | null>(null);
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState(
    () => localStorage.getItem(ADDRESS_KEY) ?? '',
  );
  const [logs, setLogs] = useState<string[]>([
    'Amplop preprod deploy console — connect Lace to begin.',
  ]);
  const logRef = useRef<HTMLDivElement>(null);

  const log = useCallback((msg: string) => {
    setLogs((prev) => [...prev, msg]);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const connect = async () => {
    const lace = findLace();
    if (!lace) {
      log('❌ Lace wallet not found in this browser.');
      return;
    }
    setBusy(true);
    try {
      log('Connecting to Lace… (approve the connection in Lace)');
      const connected = await lace.enable();
      try {
        await connected.hintUsage?.([
          'balanceUnsealedTransaction',
          'submitTransaction',
          'getConfiguration',
          'getShieldedAddresses',
        ]);
      } catch {
        /* hinting is best-effort */
      }
      const built = await buildBrowserProviders(connected);
      setApi(connected);
      setBp(built);
      log(`Connected. Network: ${built.config.networkId}`);
      log(`Indexer: ${built.config.indexerUri}`);
      log(`Proof server (via config/default): ${built.proofServerUri}`);
      if (built.config.networkId !== 'preprod') {
        log(
          '⚠️ Lace is NOT on Preprod. Switch Lace → Settings → Midnight → Network: Preprod, then reconnect.',
        );
      }
    } catch (e) {
      log(`❌ Connect failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      log(`❌ Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onDeploy = () =>
    bp &&
    run(async () => {
      const addr = await deployAmplop(bp, log);
      setAddress(addr);
      localStorage.setItem(ADDRESS_KEY, addr);
    });

  const onSmoke = () =>
    bp &&
    run(async () => {
      if (!address.trim()) {
        log('❌ No contract address — deploy first, or paste an address.');
        return;
      }
      await smokeAmplop(bp, address.trim(), log);
    });

  const btn = busy ? styles.buttonDisabled : styles.button;

  return (
    <div style={styles.page}>
      <h1>🖤 Amplop — Preprod Deploy Console</h1>
      <p>
        Deploys the AmplopAuction contract to <b>Midnight Preprod</b> using
        your own Lace wallet, then runs a full live auction smoke cycle.
        This page exists because a cold server-side SDK wallet needs hours
        to replay the dust ledger; Lace is already synced.
      </p>

      <div style={styles.warn}>
        <b>Before you start:</b>
        <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
          <li>
            Lace must be on <b>Preprod</b> (Settings → Midnight → Network)
            and hold tNIGHT + generated tDUST (Midnight → Generate tDUST).
          </li>
          <li>
            Your <b>proof server must be running</b> at the address shown
            after connecting (default <span style={styles.mono}>http://localhost:6300</span>):
            <span style={styles.mono}>
              {' '}
              docker run -p 6300:6300 midnightntwrk/proof-server:8.1.3
            </span>
          </li>
          <li>
            Keep this tab open during the smoke cycle (~7 minutes) and
            approve each transaction in Lace.
          </li>
        </ol>
      </div>

      <div style={styles.card}>
        <div style={{ marginBottom: 10 }}>
          Lace wallet:{' '}
          {laceFound ? (
            api ? (
              <b style={{ color: '#1d7a3a' }}>connected</b>
            ) : (
              <b>found, not connected</b>
            )
          ) : (
            <b style={{ color: '#b03030' }}>not found in this browser</b>
          )}
        </div>
        <button style={btn} disabled={busy || !laceFound} onClick={connect}>
          1. Connect Lace
        </button>
        <button
          style={btn}
          disabled={busy || !bp}
          onClick={onDeploy}
        >
          2. Deploy contract
        </button>
        <button style={btn} disabled={busy || !bp} onClick={onSmoke}>
          3. Run smoke cycle
        </button>
        <div style={{ marginTop: 12 }}>
          Contract address:{' '}
          <input
            style={{ ...styles.mono, width: '100%', padding: 6, marginTop: 4 }}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="deployed contract address appears here"
          />
        </div>
      </div>

      <div style={styles.log} ref={logRef}>
        {logs.join('\n')}
      </div>
    </div>
  );
}
