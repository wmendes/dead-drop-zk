import { config } from './config';
import { Layout } from './components/Layout';
import { PhoneFrame } from './components/PhoneFrame';
import { useWallet } from './hooks/useWallet';
import { DeadDropGame } from './games/dead-drop/DeadDropGame';
import { ProofBenchmark } from './pages/ProofBenchmark';
import { useState } from 'react';

const GAME_ID = 'dead-drop';
const GAME_TITLE = import.meta.env.VITE_GAME_TITLE || 'Dead Drop';
const GAME_TAGLINE = import.meta.env.VITE_GAME_TAGLINE || 'ZK Scavenger Hunt on Stellar';

export default function App() {
  if (new URLSearchParams(window.location.search).has('benchmark')) {
    return <ProofBenchmark />;
  }
  const {
    publicKey,
    isConnected,
    isConnecting,
    error,
    walletType,
    walletMode,
    connect,
    disconnect,
    createSmartAccount,
    isSmartAccountReady,
    isWalletAvailable,
  } = useWallet();
  const [smartAccountLabel, setSmartAccountLabel] = useState('');
  const userAddress = publicKey ?? '';
  const contractId = config.contractIds[GAME_ID] || '';
  const hasContract = contractId && contractId !== 'YOUR_CONTRACT_ID';
  const isDevOnlyMode = walletMode === 'dev';
  const smartAccountMode = walletMode === 'smart-account' || walletMode === 'hybrid';

  const content = (
    <Layout title={GAME_TITLE} subtitle={GAME_TAGLINE}>
      {!hasContract ? (
        <div className="card">
          <h3 className="gradient-text">Contract Not Configured</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem', fontSize: '0.875rem' }}>
            Run <code style={{ color: 'var(--color-accent)' }}>bun run setup</code> to deploy and configure testnet contract IDs.
          </p>
        </div>
      ) : !isWalletAvailable ? (
        <div className="card">
          <h3 className="gradient-text">Browser Required</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem', fontSize: '0.875rem' }}>
            Wallet and passkey auth are only available in the browser.
          </p>
        </div>
      ) : !isConnected ? (
        <div className="card">
          <h3 className="gradient-text">{isDevOnlyMode ? 'Connecting' : 'Connect Wallet'}</h3>
          {isDevOnlyMode ? (
            <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem', fontSize: '0.875rem' }}>
              Auto-connecting dev wallet...
            </p>
          ) : (
            <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem', fontSize: '0.875rem' }}>
              Connect to continue.
            </p>
          )}

          {!isDevOnlyMode && (
            <button
              style={{ marginTop: '0.75rem' }}
              className="btn btn-primary"
              onClick={() => connect().catch(() => undefined)}
              disabled={isConnecting}
            >
              {isConnecting ? 'Connecting...' : (smartAccountMode ? 'Connect Existing Passkey Wallet' : 'Connect')}
            </button>
          )}

          {smartAccountMode && !isSmartAccountReady && (
            <div className="notice warning" style={{ marginTop: '0.75rem' }}>
              Configure <code>VITE_SMART_ACCOUNT_WASM_HASH</code> and <code>VITE_SMART_ACCOUNT_WEBAUTHN_VERIFIER_ADDRESS</code> to enable passkeys.
            </div>
          )}

          {smartAccountMode && isSmartAccountReady && (
            <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.5rem' }}>
              <input
                className="input"
                value={smartAccountLabel}
                onChange={(event) => setSmartAccountLabel(event.target.value)}
                placeholder="name@example.com"
              />
              <button
                className="btn"
                onClick={() => createSmartAccount(smartAccountLabel).catch(() => undefined)}
                disabled={isConnecting || !smartAccountLabel.trim()}
              >
                Create Passkey Wallet
              </button>
            </div>
          )}

          {error && <div className="notice error" style={{ marginTop: '0.75rem' }}>{error}</div>}
          {isConnecting && <div className="notice info" style={{ marginTop: '0.75rem' }}>Connecting...</div>}
        </div>
      ) : (
        <>
          {(walletType === 'smart-account' || walletType === 'wallet') && (
            <div className="card" style={{ marginBottom: '0.75rem' }}>
              <p style={{ color: 'var(--color-ink-muted)', fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                Connected: <code style={{ color: 'var(--color-accent)' }}>{userAddress}</code>
              </p>
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                {walletType === 'smart-account' && isSmartAccountReady && (
                  <>
                    <input
                      className="input"
                      value={smartAccountLabel}
                      onChange={(event) => setSmartAccountLabel(event.target.value)}
                      placeholder="name@example.com"
                    />
                    <button
                      className="btn"
                      onClick={() => createSmartAccount(smartAccountLabel).catch(() => undefined)}
                      disabled={isConnecting || !smartAccountLabel.trim()}
                    >
                      Create New Passkey Wallet
                    </button>
                  </>
                )}
                <button
                  className="btn"
                  onClick={() => disconnect().catch(() => undefined)}
                  disabled={isConnecting}
                >
                  Disconnect Wallet
                </button>
              </div>
            </div>
          )}

          <DeadDropGame
            userAddress={userAddress}
            currentEpoch={1}
            availablePoints={1000000000n}
            onStandingsRefresh={() => {}}
            onGameComplete={() => {}}
          />
        </>
      )}
    </Layout>
  );

  return <PhoneFrame>{content}</PhoneFrame>;
}
