/**
 * ZK Proof Benchmark Page
 *
 * Accessible via ?benchmark query param. No wallet required.
 * Tests backend randomness bootstrap + proof generation.
 */

import { useState, useCallback } from 'react';
import { getSessionRandomness, provePing } from '../games/dead-drop/deadDropProofService';

const DEFAULT_PROVER_URL =
  (import.meta.env.VITE_DEAD_DROP_PROVER_URL as string) || 'http://localhost:8787';

const SESSION_ID = 12345;
const TURN = 1;
const PING_X = 50;
const PING_Y = 50;

type PhaseStatus = 'pending' | 'running' | 'done' | 'error';

interface Phase {
  name: string;
  description: string;
  status: PhaseStatus;
  durationMs?: number;
}

const PHASE_DEFS = [
  { name: 'Session randomness', description: 'POST /randomness/session' },
  { name: 'Backend /prove/ping', description: 'Witness + proof generation on Node.js server' },
] as const;

const STATUS_ICONS: Record<PhaseStatus, string> = {
  pending: '⏳',
  running: '🔄',
  done: '✅',
  error: '❌',
};

interface Summary {
  totalMs: number;
  distance: number;
  proofSizeBytes: number;
  publicInputsCount: number;
}

export function ProofBenchmark() {
  const [proverUrl, setProverUrl] = useState(DEFAULT_PROVER_URL);
  const [phases, setPhases] = useState<Phase[]>(
    PHASE_DEFS.map((d) => ({ ...d, status: 'pending' }))
  );
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const updatePhase = useCallback(
    (index: number, update: Partial<Phase>) =>
      setPhases((prev) => prev.map((p, i) => (i === index ? { ...p, ...update } : p))),
    []
  );

  const reset = useCallback(() => {
    setPhases(PHASE_DEFS.map((d) => ({ ...d, status: 'pending' })));
    setSummary(null);
    setFatalError(null);
  }, []);

  const run = useCallback(async () => {
    reset();
    setRunning(true);

    const overallStart = performance.now();

    try {
      updatePhase(0, { status: 'running' });
      const t0 = performance.now();
      await getSessionRandomness(proverUrl, SESSION_ID);
      updatePhase(0, { status: 'done', durationMs: Math.round(performance.now() - t0) });

      updatePhase(1, { status: 'running' });
      const t1 = performance.now();
      const result = await provePing(proverUrl, {
        sessionId: SESSION_ID,
        turn: TURN,
        pingX: PING_X,
        pingY: PING_Y,
      });
      updatePhase(1, { status: 'done', durationMs: Math.round(performance.now() - t1) });

      setSummary({
        totalMs: Math.round(performance.now() - overallStart),
        distance: result.distance,
        proofSizeBytes: result.proofHex.length / 2,
        publicInputsCount: result.publicInputsHex.length,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setFatalError(msg);
      setPhases((prev) =>
        prev.map((p) => (p.status === 'running' ? { ...p, status: 'error' } : p))
      );
    } finally {
      setRunning(false);
    }
  }, [reset, updatePhase, proverUrl]);

  const isDone = !running && (summary !== null || fatalError !== null);

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0f', color: '#e2e8f0', padding: '2rem', fontFamily: 'monospace' }}>
      <div style={{ maxWidth: '640px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.25rem', color: '#a78bfa' }}>
          ZK Proof Benchmark
        </h1>
        <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
          Tests backend flow: <code style={{ color: '#a78bfa' }}>POST /randomness/session</code> then <code style={{ color: '#a78bfa' }}>POST /prove/ping</code>.
          <br />
          Inputs: ping=({PING_X},{PING_Y}), session={SESSION_ID}, turn={TURN}.
        </p>

        <div style={{ marginBottom: '1.5rem' }}>
          <label style={{ display: 'block', fontSize: '0.75rem', color: '#64748b', marginBottom: '0.375rem' }}>
            Backend URL
          </label>
          <input
            value={proverUrl}
            onChange={(e) => setProverUrl(e.target.value)}
            disabled={running}
            style={{
              width: '100%',
              padding: '0.5rem 0.75rem',
              background: '#141420',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#e2e8f0',
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <ol style={{ listStyle: 'none', padding: 0, margin: '0 0 1.5rem 0', display: 'grid', gap: '0.625rem' }}>
          {phases.map((phase, i) => (
            <li
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.75rem 1rem',
                background: '#141420',
                borderRadius: '0.5rem',
                border: `1px solid ${
                  phase.status === 'running' ? '#7c3aed'
                    : phase.status === 'done' ? '#16a34a'
                      : phase.status === 'error' ? '#dc2626'
                        : '#1e1e2e'
                }`,
              }}
            >
              <span style={{ fontSize: '1.25rem', minWidth: '1.5rem' }}>{STATUS_ICONS[phase.status]}</span>
              <span style={{ flex: 1 }}>
                <div style={{ fontSize: '0.9rem', color: phase.status === 'pending' ? '#64748b' : '#e2e8f0' }}>
                  {i + 1}. {phase.name}
                </div>
                <div style={{ fontSize: '0.75rem', color: '#475569', marginTop: '0.125rem' }}>
                  {phase.description}
                </div>
              </span>
              {phase.durationMs !== undefined && (
                <span style={{ fontSize: '0.875rem', color: '#a78bfa', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {phase.durationMs.toLocaleString()} ms
                </span>
              )}
              {phase.status === 'running' && (
                <span style={{ fontSize: '0.75rem', color: '#a78bfa' }}>running…</span>
              )}
            </li>
          ))}
        </ol>

        {summary && (
          <div style={{ background: '#141420', border: '1px solid #16a34a', borderRadius: '0.5rem', padding: '1rem 1.25rem', marginBottom: '1.5rem' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: '#4ade80' }}>
              Summary
            </h2>
            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.25rem 1rem', fontSize: '0.875rem' }}>
              <dt style={{ color: '#94a3b8' }}>Total time</dt>
              <dd style={{ color: '#e2e8f0', fontWeight: 600 }}>
                {summary.totalMs.toLocaleString()} ms{' '}
                <span style={{ color: '#64748b', fontWeight: 400 }}>({(summary.totalMs / 1000).toFixed(1)} s)</span>
              </dd>
              <dt style={{ color: '#94a3b8' }}>Distance</dt>
              <dd style={{ color: '#e2e8f0', fontWeight: 600 }}>{summary.distance}</dd>
              <dt style={{ color: '#94a3b8' }}>Proof size</dt>
              <dd style={{ color: '#e2e8f0', fontWeight: 600 }}>{summary.proofSizeBytes.toLocaleString()} bytes</dd>
              <dt style={{ color: '#94a3b8' }}>Public inputs</dt>
              <dd style={{ color: '#e2e8f0', fontWeight: 600 }}>{summary.publicInputsCount}</dd>
            </dl>
          </div>
        )}

        {fatalError && (
          <div style={{ background: '#1a0a0a', border: '1px solid #dc2626', borderRadius: '0.5rem', padding: '1rem 1.25rem', marginBottom: '1.5rem', fontSize: '0.8rem', color: '#fca5a5', wordBreak: 'break-all' }}>
            <strong style={{ display: 'block', marginBottom: '0.25rem', color: '#f87171' }}>Error</strong>
            {fatalError}
          </div>
        )}

        {!isDone ? (
          <button
            onClick={run}
            disabled={running}
            style={{ padding: '0.625rem 1.5rem', background: running ? '#3b1f6e' : '#7c3aed', color: running ? '#a78bfa' : '#fff', border: 'none', borderRadius: '0.375rem', fontSize: '0.9rem', fontWeight: 600, cursor: running ? 'not-allowed' : 'pointer', fontFamily: 'monospace' }}
          >
            {running ? 'Running…' : 'Run Benchmark'}
          </button>
        ) : (
          <button
            onClick={reset}
            style={{ padding: '0.625rem 1.5rem', background: '#1e293b', color: '#a78bfa', border: '1px solid #334155', borderRadius: '0.375rem', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'monospace' }}
          >
            Run Again
          </button>
        )}
      </div>
    </div>
  );
}
