import { useEffect, useState } from 'react';
import { Check, Copy, Loader2, LogOut, Wifi, WifiOff } from 'lucide-react';
import { useWallet } from '../hooks/useWallet';
import { DeadDropLogo } from './DeadDropLogo';
import './Layout.css';

interface LayoutProps {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function Layout({ title, subtitle, children }: LayoutProps) {
  const {
    connectDev,
    switchPlayer,
    getCurrentDevPlayer,
    isConnected,
    isConnecting,
    publicKey,
    walletType,
    walletMode,
    disconnect,
  } = useWallet();
  const isDevMode = walletMode === 'dev' || walletMode === 'hybrid';
  const currentPlayer = getCurrentDevPlayer();
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const resolvedTitle = title || import.meta.env.VITE_GAME_TITLE || 'Stellar Game';
  const resolvedSubtitle = subtitle || import.meta.env.VITE_GAME_TAGLINE || 'Testnet dev sandbox';
  const shortAddress = publicKey ? `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}` : 'Not Connected';

  const onPlayerSelect = async (player: 1 | 2) => {
    try {
      if (!isDevMode) {
        return;
      }

      if (!isConnected) {
        await connectDev(player);
      } else if (walletType === 'dev') {
        if (currentPlayer !== player) {
          await switchPlayer(player);
        }
      }
    } catch (e) {
      console.error('Failed to switch player', e);
    }
  };

  // Auto-connect to Player 1 if not connected
  useEffect(() => {
    if (isDevMode && !isConnected && !walletType) {
      connectDev(1).catch(console.error);
    }
  }, [isConnected, connectDev, walletType, isDevMode]);

  const copyAddress = async () => {
    if (!publicKey || !isConnected) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 1200);
    } catch {
      // noop
    }
  };

  const onDisconnect = async () => {
    if (!isConnected || disconnecting) return;
    try {
      setDisconnecting(true);
      await disconnect();
    } catch (e) {
      console.error('Failed to disconnect wallet', e);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="studio">
      <div className="studio-background" aria-hidden="true">
        <div className="studio-orb orb-1" />
        <div className="studio-orb orb-2" />
        <div className="studio-orb orb-3" />
        <div className="studio-grid" />
      </div>

      <header className="studio-header">
        <div className="brand-shell">
          <div className="brand-mark" aria-hidden="true">
            <DeadDropLogo size={30} animated={false} glow={false} />
          </div>
          <div className="brand">
            <div className="brand-title">{resolvedTitle}</div>
            <p className="brand-subtitle">{resolvedSubtitle}</p>
          </div>
        </div>

        <div className={`wallet-actions ${isConnected ? 'connected' : ''}`}>
          <button
            type="button"
            className={`wallet-chip ${isConnected ? 'connected' : 'disconnected'}`}
            onClick={() => {
              void copyAddress();
            }}
            disabled={!isConnected}
            title={isConnected ? 'Copy full wallet address' : 'Wallet disconnected'}
          >
            <span className="wallet-chip-status" aria-hidden="true">
              {isConnecting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : isConnected ? (
                <Wifi className="w-3 h-3" />
              ) : (
                <WifiOff className="w-3 h-3" />
              )}
            </span>
            <span className="wallet-chip-text">{shortAddress}</span>
            {isConnected && (
              <span className="wallet-chip-copy" aria-hidden="true">
                {copiedAddress ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              </span>
            )}
            <span className="wallet-chip-type">{walletType === 'dev' ? 'Dev' : walletType === 'wallet' ? 'Wallet' : 'Guest'}</span>
          </button>

          {isConnected && (
            <button
              type="button"
              className="wallet-disconnect"
              onClick={() => {
                void onDisconnect();
              }}
              disabled={disconnecting}
              title="Disconnect wallet"
              aria-label="Disconnect wallet"
            >
              {disconnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </header>

      <main className="studio-main">{children}</main>

      <footer className="studio-footer">
        <span>Built with the Stellar Game Studio</span>
      </footer>

      {isDevMode && (
        <div className="studio-footer-menu">
          <button
            className={`player-switch-button p1 ${currentPlayer === 1 ? 'active' : ''}`}
            onClick={() => onPlayerSelect(1)}
          >
            Player 1
          </button>
          <button
            className={`player-switch-button p2 ${currentPlayer === 2 ? 'active' : ''}`}
            onClick={() => onPlayerSelect(2)}
          >
            Player 2
          </button>
        </div>
      )}
    </div>
  );
}
