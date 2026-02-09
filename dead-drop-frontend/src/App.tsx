import { config } from './config';
import { Layout } from './components/Layout';
import { PhoneFrame } from './components/PhoneFrame';
import { useWallet } from './hooks/useWallet';
import { DeadDropGame } from './games/dead-drop/DeadDropGame';

const GAME_ID = 'dead-drop';
const GAME_TITLE = import.meta.env.VITE_GAME_TITLE || 'Dead Drop';
const GAME_TAGLINE = import.meta.env.VITE_GAME_TAGLINE || 'ZK Scavenger Hunt on Stellar';

export default function App() {
  const { publicKey, isConnected, isConnecting, error, isDevModeAvailable } = useWallet();
  const userAddress = publicKey ?? '';
  const contractId = config.contractIds[GAME_ID] || '';
  const hasContract = contractId && contractId !== 'YOUR_CONTRACT_ID';
  const devReady = isDevModeAvailable();

  const content = (
    <Layout title={GAME_TITLE} subtitle={GAME_TAGLINE}>
      {!hasContract ? (
        <div className="card">
          <h3 className="gradient-text">Contract Not Configured</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem', fontSize: '0.875rem' }}>
            Run <code style={{ color: 'var(--color-accent)' }}>bun run setup</code> to deploy and configure testnet contract IDs.
          </p>
        </div>
      ) : !devReady ? (
        <div className="card">
          <h3 className="gradient-text">Dev Wallets Missing</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem', fontSize: '0.875rem' }}>
            Run <code style={{ color: 'var(--color-accent)' }}>bun run setup</code> to generate dev wallets.
          </p>
        </div>
      ) : !isConnected ? (
        <div className="card">
          <h3 className="gradient-text">Connecting</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem', fontSize: '0.875rem' }}>
            Auto-connecting dev wallet...
          </p>
          {error && <div className="notice error" style={{ marginTop: '0.75rem' }}>{error}</div>}
          {isConnecting && <div className="notice info" style={{ marginTop: '0.75rem' }}>Connecting...</div>}
        </div>
      ) : (
        <DeadDropGame
          userAddress={userAddress}
          currentEpoch={1}
          availablePoints={1000000000n}
          onStandingsRefresh={() => {}}
          onGameComplete={() => {}}
        />
      )}
    </Layout>
  );

  return <PhoneFrame>{content}</PhoneFrame>;
}
