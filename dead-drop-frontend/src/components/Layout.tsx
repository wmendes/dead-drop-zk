import { useEffect } from 'react';
import { useWallet } from '../hooks/useWallet';
import './Layout.css';

interface LayoutProps {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function Layout({ title, subtitle, children }: LayoutProps) {
  const { connectDev, switchPlayer, getCurrentDevPlayer, isConnected, walletType, walletMode } = useWallet();
  const isDevMode = walletMode === 'dev' || walletMode === 'hybrid';
  const currentPlayer = getCurrentDevPlayer();

  const resolvedTitle = title || import.meta.env.VITE_GAME_TITLE || 'Stellar Game';
  const resolvedSubtitle = subtitle || import.meta.env.VITE_GAME_TAGLINE || 'Testnet dev sandbox';

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

  return (
    <div className="studio">
      <div className="studio-background" aria-hidden="true">
        <div className="studio-orb orb-1" />
        <div className="studio-orb orb-2" />
        <div className="studio-orb orb-3" />
        <div className="studio-grid" />
      </div>

      <header className="studio-header">
        <div className="brand">
          <div className="brand-title">{resolvedTitle}</div>
          <p className="brand-subtitle">{resolvedSubtitle}</p>
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
