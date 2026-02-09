import { useState, useEffect, useRef, useCallback } from 'react';
import { DeadDropService } from './deadDropService';
import { useWallet } from '@/hooks/useWallet';
import { devWalletService } from '@/services/devWalletService';
import { DEAD_DROP_CONTRACT } from '@/utils/constants';
import { getFundedSimulationSourceAddress } from '@/utils/simulationUtils';
import { Buffer } from 'buffer';
import type { Game } from './bindings';
import { GameMap, gridToLatLng, formatLatLng } from './GameMap';
import { Modal } from './components/Modal';
import { ToastSystem } from './components/ToastSystem';
import { ActionButton } from './components/ActionPanel';
import { Loader2, Crosshair, History, Info, Target, RefreshCw, Copy, Check, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const GRID_SIZE = 100;
const MAX_TURNS = 30;

type TemperatureZone = 'FOUND' | 'HOT' | 'WARM' | 'COOL' | 'COLD';

interface PingResult {
  turn: number;
  x: number;
  y: number;
  distance: number;
  zone: TemperatureZone;
}

interface PlayerSecret {
  x: number;
  y: number;
  salt: Uint8Array;
}

function getTemperatureZone(distance: number): TemperatureZone {
  if (distance === 0) return 'FOUND';
  if (distance <= 5) return 'HOT';
  if (distance <= 15) return 'WARM';
  if (distance <= 30) return 'COOL';
  return 'COLD';
}

function getZoneColor(zone: TemperatureZone): string {
  switch (zone) {
    case 'FOUND': return 'text-emerald-400';
    case 'HOT': return 'text-red-400';
    case 'WARM': return 'text-orange-400';
    case 'COOL': return 'text-cyan-400';
    case 'COLD': return 'text-blue-400';
  }
}

async function computeCommitment(secret: PlayerSecret): Promise<Buffer> {
  const data = new Uint8Array(40);
  const view = new DataView(data.buffer);
  view.setUint32(0, secret.x, true);
  view.setUint32(4, secret.y, true);
  data.set(secret.salt, 8);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(new Uint8Array(hash));
}

async function computeJournalHash(sessionId: number, turn: number, distance: number, commitment: Buffer): Promise<Buffer> {
  const data = new Uint8Array(44);
  const view = new DataView(data.buffer);
  view.setUint32(0, sessionId, true);
  view.setUint32(4, turn, true);
  view.setUint32(8, distance, true);
  data.set(commitment, 12);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(new Uint8Array(hash));
}

function generateSecret(): PlayerSecret {
  const coords = new Uint32Array(2);
  crypto.getRandomValues(coords);
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  return { x: coords[0] % GRID_SIZE, y: coords[1] % GRID_SIZE, salt };
}

function wrappedManhattan(px: number, py: number, dropX: number, dropY: number): number {
  const dx = Math.abs(px - dropX);
  const dy = Math.abs(py - dropY);
  return Math.min(dx, GRID_SIZE - dx) + Math.min(dy, GRID_SIZE - dy);
}

function getOpponentSecret(sessionId: number, opponentAddress: string): PlayerSecret | null {
  const stored = sessionStorage.getItem(`dead-drop-secret-${sessionId}-${opponentAddress}`);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    return { x: parsed.x, y: parsed.y, salt: new Uint8Array(parsed.salt) };
  } catch { return null; }
}

const createRandomSessionId = (): number => {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] || 1;
};

const deadDropService = new DeadDropService(DEAD_DROP_CONTRACT);
const MOCK_IMAGE_ID = Buffer.alloc(32, 7);

type GamePhase = 'create' | 'commit' | 'waiting_commit' | 'my_turn' | 'opponent_turn' | 'game_over';

interface DeadDropGameProps {
  userAddress: string;
  currentEpoch: number;
  availablePoints: bigint;
  initialXDR?: string | null;
  initialSessionId?: number | null;
  onStandingsRefresh: () => void;
  onGameComplete: () => void;
}

export function DeadDropGame({
  userAddress,
  availablePoints,
  onStandingsRefresh,
  onGameComplete
}: DeadDropGameProps) {
  const DEFAULT_POINTS = '0.1';
  const POINTS_DECIMALS = 7;
  const { getContractSigner } = useWallet();

  const [sessionId, setSessionId] = useState<number>(() => createRandomSessionId());
  const [gameState, setGameState] = useState<Game | null>(null);
  const [gamePhase, setGamePhase] = useState<GamePhase>('create');
  const [playerSecret, setPlayerSecret] = useState<PlayerSecret | null>(null);
  const [pingHistory, setPingHistory] = useState<PingResult[]>([]);

  const [createMode, setCreateMode] = useState<'create' | 'import' | 'load'>('create');
  const [player1Points, setPlayer1Points] = useState(DEFAULT_POINTS);
  const [exportedAuthEntryXDR, setExportedAuthEntryXDR] = useState<string | null>(null);
  const [importAuthEntryXDR, setImportAuthEntryXDR] = useState('');
  const [importPlayer2Points, setImportPlayer2Points] = useState(DEFAULT_POINTS);
  const [loadSessionId, setLoadSessionId] = useState('');

  const [selectedCell, setSelectedCell] = useState<{ x: number; y: number } | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  // Modals
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [showGameOverModal, setShowGameOverModal] = useState(false);

  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'success' | 'info'; id: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const actionLock = useRef(false);

  const showToast = (message: string, type: 'error' | 'success' | 'info') => {
    setToast({ message, type, id: crypto.randomUUID() });
  };

  const parsePoints = (value: string): bigint | null => {
    try {
      const cleaned = value.replace(/[^\d.]/g, '');
      if (!cleaned || cleaned === '.') return null;
      const [whole = '0', fraction = ''] = cleaned.split('.');
      const paddedFraction = fraction.padEnd(POINTS_DECIMALS, '0').slice(0, POINTS_DECIMALS);
      return BigInt(whole + paddedFraction);
    } catch { return null; }
  };

  const runAction = async (action: () => Promise<void>) => {
    if (actionLock.current || loading) return;
    actionLock.current = true;
    try { await action(); } finally { actionLock.current = false; }
  };

  const derivePhase = useCallback((game: Game | null): GamePhase => {
    if (!game) return 'create';
    const isP1 = game.player1 === userAddress;
    const isP2 = game.player2 === userAddress;
    if (!isP1 && !isP2) return 'create';
    if (game.winner) return 'game_over';

    const statusVal = typeof game.status === 'number' ? game.status : 0;
    const emptyCommitment = Buffer.alloc(32, 0);

    const myCommitmentEmpty = isP1
      ? Buffer.from(game.commitment1 as any).equals(emptyCommitment)
      : Buffer.from(game.commitment2 as any).equals(emptyCommitment);

    if (statusVal <= 1 && myCommitmentEmpty) return 'commit';
    if (statusVal <= 1) return 'waiting_commit';
    if (statusVal === 2) {
      const isMyTurn = (game.whose_turn === 1 && isP1) || (game.whose_turn === 2 && isP2);
      return isMyTurn ? 'my_turn' : 'opponent_turn';
    }
    return 'game_over';
  }, [userAddress]);

  // Poll game state
  useEffect(() => {
    if (gamePhase === 'create') return;
    const load = async () => {
      const game = await deadDropService.getGame(sessionId);
      if (game) {
        setGameState(game);
        const newPhase = derivePhase(game);
        if (newPhase === 'game_over' && gamePhase !== 'game_over') {
          setShowGameOverModal(true);
        }
        setGamePhase(newPhase);
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [sessionId, gamePhase, derivePhase]);

  // Restore secret
  useEffect(() => {
    const stored = sessionStorage.getItem(`dead-drop-secret-${sessionId}-${userAddress}`);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setPlayerSecret({ x: parsed.x, y: parsed.y, salt: new Uint8Array(parsed.salt) });
      } catch { setPlayerSecret(null); }
    } else { setPlayerSecret(null); }
  }, [sessionId, userAddress]);

  const getDropCoords = useCallback((): { x: number; y: number } | null => {
    if (!playerSecret || !gameState) return null;
    const isP1 = gameState.player1 === userAddress;
    const opponentAddr = isP1 ? gameState.player2 : gameState.player1;
    const opponentSecret = getOpponentSecret(sessionId, opponentAddr);
    if (!opponentSecret) return null;
    return {
      x: (playerSecret.x + opponentSecret.x) % GRID_SIZE,
      y: (playerSecret.y + opponentSecret.y) % GRID_SIZE,
    };
  }, [playerSecret, gameState, sessionId, userAddress]);

  // Actions
  const handleQuickMatch = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        showToast('Starting match...', 'info');

        const stakePoints = parsePoints(DEFAULT_POINTS) || 1000000n;

        // Get signers for both players
        const player1Signer = devWalletService.getSignerForPlayer(1);
        const player2Signer = devWalletService.getSignerForPlayer(2);
        const player1Address = devWalletService.getPublicKeyForPlayer(1);
        const player2Address = devWalletService.getPublicKeyForPlayer(2);

        // Use the dedicated quick match method
        await deadDropService.quickMatchStart(
          sessionId,
          player1Address,
          player2Address,
          player1Signer,
          player2Signer,
          stakePoints
        );

        // Load the game
        const game = await deadDropService.getGame(sessionId);
        setGameState(game);
        setGamePhase('commit');
        onStandingsRefresh();
        showToast('Match started!', 'success');
      } catch (err: any) {
        showToast(err.message || 'Failed to start match', 'error');
      } finally {
        setLoading(false);
      }
    });
  };

  const handleImportAndStart = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        if (!importAuthEntryXDR.trim()) throw new Error('Paste auth entry XDR');
        const p2Points = parsePoints(importPlayer2Points);
        if (!p2Points || p2Points <= 0n) throw new Error('Enter valid points');
        const gameParams = deadDropService.parseAuthEntry(importAuthEntryXDR.trim());
        if (gameParams.player1 === userAddress) throw new Error('Cannot play against yourself');
        const signer = getContractSigner();
        const fullySignedXDR = await deadDropService.importAndSignAuthEntry(
          importAuthEntryXDR.trim(), userAddress, p2Points, signer
        );
        await deadDropService.finalizeStartGame(fullySignedXDR, userAddress, signer);
        setSessionId(gameParams.sessionId);
        const game = await deadDropService.getGame(gameParams.sessionId);
        setGameState(game); setGamePhase('commit'); onStandingsRefresh();
        showToast('Game started!', 'success');
      } catch (err: any) {
        showToast(err.message || 'Failed to import', 'error');
      } finally { setLoading(false); }
    });
  };

  const handleLoadGame = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        const id = parseInt(loadSessionId.trim());
        if (isNaN(id) || id <= 0) throw new Error('Enter a valid session ID');
        const game = await deadDropService.getGame(id);
        if (!game) throw new Error('Game not found');
        if (game.player1 !== userAddress && game.player2 !== userAddress) throw new Error('You are not a player');
        setSessionId(id); setGameState(game); setGamePhase(derivePhase(game));
        showToast('Game loaded!', 'success');
      } catch (err: any) {
        showToast(err.message || 'Failed to load', 'error');
      } finally { setLoading(false); }
    });
  };

  const handleCommitSecret = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        const secret = generateSecret();
        setPlayerSecret(secret);
        sessionStorage.setItem(`dead-drop-secret-${sessionId}-${userAddress}`, JSON.stringify({
          x: secret.x, y: secret.y, salt: Array.from(secret.salt)
        }));
        const commitment = await computeCommitment(secret);
        const signer = getContractSigner();
        await deadDropService.commitSecret(sessionId, userAddress, commitment, signer);
        showToast('Secret committed!', 'success');
        const game = await deadDropService.getGame(sessionId);
        setGameState(game); setGamePhase(derivePhase(game));
      } catch (err: any) {
        showToast(err.message || 'Failed to commit', 'error');
      } finally { setLoading(false); }
    });
  };

  const handleSubmitPing = async () => {
    if (!selectedCell || !gameState) return;
    await runAction(async () => {
      try {
        setLoading(true);
        const isP1 = gameState.player1 === userAddress;
        const opponentAddr = isP1 ? gameState.player2 : gameState.player1;
        const responderCommitment = isP1
          ? Buffer.from(gameState.commitment2 as any)
          : Buffer.from(gameState.commitment1 as any);

        const opponentSecret = getOpponentSecret(sessionId, opponentAddr);
        let mockDistance: number;
        if (playerSecret && opponentSecret) {
          const dropX = (playerSecret.x + opponentSecret.x) % GRID_SIZE;
          const dropY = (playerSecret.y + opponentSecret.y) % GRID_SIZE;
          mockDistance = wrappedManhattan(selectedCell.x, selectedCell.y, dropX, dropY);
        } else {
          mockDistance = Math.floor(Math.random() * 50) + 1;
        }
        const journalHash = await computeJournalHash(sessionId, gameState.current_turn, mockDistance, responderCommitment);
        const signer = getContractSigner();
        await deadDropService.submitPing(
          sessionId, userAddress, gameState.current_turn, mockDistance,
          journalHash, MOCK_IMAGE_ID, Buffer.from([1, 2, 3]), signer
        );

        const zone = getTemperatureZone(mockDistance);
        setPingHistory(prev => [...prev, {
          turn: gameState.current_turn, x: selectedCell.x, y: selectedCell.y, distance: mockDistance, zone
        }]);
        setSelectedCell(null);
        showToast(mockDistance === 0 ? 'DROP FOUND!' : `${zone}`, 'info');
        const updatedGame = await deadDropService.getGame(sessionId);
        setGameState(updatedGame);
        const newPhase = derivePhase(updatedGame);
        setGamePhase(newPhase);
        if (newPhase === 'game_over') {
          setShowGameOverModal(true);
        }
      } catch (err: any) {
        showToast(err.message || 'Failed to submit ping', 'error');
      } finally { setLoading(false); }
    });
  };

  const handleForceTimeout = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        const signer = getContractSigner();
        await deadDropService.forceTimeout(sessionId, userAddress, signer);
        showToast('Timeout claimed!', 'success');
        const game = await deadDropService.getGame(sessionId);
        setGameState(game); setGamePhase('game_over'); setShowGameOverModal(true); onStandingsRefresh();
      } catch (err: any) {
        showToast(err.message || 'Timeout not reached yet', 'error');
      } finally { setLoading(false); }
    });
  };

  const handleStartNewGame = () => {
    if (gameState?.winner) onGameComplete();
    actionLock.current = false;
    setGamePhase('create'); setSessionId(createRandomSessionId());
    setGameState(null); setPlayerSecret(null); setPingHistory([]);
    setSelectedCell(null); setLoading(false);
    setCreateMode('create'); setExportedAuthEntryXDR(null);
    setImportAuthEntryXDR(''); setImportPlayer2Points(DEFAULT_POINTS);
    setLoadSessionId(''); setCopied(false); setPlayer1Points(DEFAULT_POINTS);
    setShowDebug(false); setShowGameOverModal(false);
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    showToast('Copied!', 'info');
    setTimeout(() => setCopied(false), 2000);
  };

  // Render
  return (
    <div className="relative min-h-full flex flex-col">
      {/* Minimal HUD */}
      {gamePhase !== 'create' && (
        <div className="flex items-center justify-between px-4 py-2 bg-black/40 border-b border-emerald-500/10">
          <button
            onClick={() => setShowInfoModal(true)}
            className="p-2 text-slate-400 hover:text-emerald-400 transition-colors"
          >
            <Info className="w-5 h-5" />
          </button>

          <div className="text-center">
            <span className="text-xs text-slate-500 uppercase tracking-widest">Turn</span>
            <span className="ml-2 text-lg font-bold text-emerald-400">{gameState?.current_turn ?? 0}</span>
            <span className="text-slate-600">/{MAX_TURNS}</span>
          </div>

          <button
            onClick={() => setShowHistoryModal(true)}
            className="p-2 text-slate-400 hover:text-emerald-400 transition-colors relative"
          >
            <History className="w-5 h-5" />
            {pingHistory.length > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 text-black text-[10px] font-bold rounded-full flex items-center justify-center">
                {pingHistory.length}
              </span>
            )}
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col">
        {/* CREATE SCREEN - Quick Match */}
        {gamePhase === 'create' && (
          <div className="flex-1 flex items-center justify-center p-8">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-center space-y-8 max-w-xs"
            >
              <div className="space-y-2">
                <h1 className="text-2xl font-black text-emerald-400 uppercase tracking-widest">Dead Drop</h1>
                <p className="text-xs text-slate-500">Find the secret location before your opponent</p>
              </div>

              <div className="w-20 h-20 mx-auto border-2 border-emerald-500/30 rounded-full flex items-center justify-center bg-emerald-500/5">
                <Target className="w-10 h-10 text-emerald-400" />
              </div>

              <ActionButton
                label="Quick Match"
                onClick={handleQuickMatch}
                loading={loading}
                variant="primary"
                fullWidth
                icon={<Zap className="w-4 h-4" />}
              />

              <p className="text-[10px] text-slate-600 uppercase tracking-wide">Dev Mode • Auto Match</p>
            </motion.div>
          </div>
        )}

        {/* COMMIT PHASE */}
        {gamePhase === 'commit' && (
          <div className="flex-1 flex items-center justify-center p-8">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-center space-y-6"
            >
              <div className="w-16 h-16 mx-auto border-2 border-purple-500/50 rounded-full flex items-center justify-center">
                <Target className="w-8 h-8 text-purple-400" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-purple-400 uppercase tracking-widest">Set Drop Location</h2>
                <p className="text-xs text-slate-500 mt-2">Your secret coordinates will be encrypted</p>
              </div>
              <ActionButton
                label="Lock Coordinates"
                onClick={handleCommitSecret}
                loading={loading}
                variant="primary"
                icon={<Target className="w-4 h-4" />}
              />
            </motion.div>
          </div>
        )}

        {/* WAITING */}
        {gamePhase === 'waiting_commit' && (
          <div className="flex-1 flex items-center justify-center p-8">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center space-y-4"
            >
              <Loader2 className="w-12 h-12 text-cyan-400 mx-auto animate-spin" />
              <p className="text-sm text-cyan-400 uppercase tracking-widest">Waiting for opponent...</p>
            </motion.div>
          </div>
        )}

        {/* MAIN GAMEPLAY */}
        {(gamePhase === 'my_turn' || gamePhase === 'opponent_turn') && (
          <div className="flex-1 flex flex-col">
            <div className="flex-1 relative">
              <GameMap
                pingHistory={pingHistory}
                selectedCell={selectedCell}
                onCellSelect={setSelectedCell}
                interactive={gamePhase === 'my_turn'}
                showDrop={showDebug}
                dropCoords={getDropCoords()}
              />

              {/* Turn indicator */}
              <AnimatePresence>
                {gamePhase === 'opponent_turn' && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 bg-black/50 flex items-center justify-center"
                  >
                    <div className="text-center">
                      <Loader2 className="w-8 h-8 text-slate-400 mx-auto animate-spin mb-2" />
                      <p className="text-sm text-slate-400 uppercase tracking-widest">Opponent's turn</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Action bar */}
            {gamePhase === 'my_turn' && selectedCell && (
              <motion.div
                initial={{ y: 100 }}
                animate={{ y: 0 }}
                className="p-4 bg-black/60 border-t border-emerald-500/20"
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <span className="text-[10px] text-slate-500 uppercase block">Target</span>
                    <span className="text-lg font-bold text-emerald-400 font-mono">
                      {formatLatLng(gridToLatLng(selectedCell.x, selectedCell.y).lat, gridToLatLng(selectedCell.x, selectedCell.y).lng)}
                    </span>
                  </div>
                  <ActionButton
                    label="PING"
                    onClick={handleSubmitPing}
                    loading={loading}
                    variant="primary"
                    icon={<Crosshair className="w-4 h-4" />}
                  />
                </div>
              </motion.div>
            )}
          </div>
        )}

        {/* GAME OVER (map still visible) */}
        {gamePhase === 'game_over' && (
          <div className="flex-1 relative">
            <GameMap
              pingHistory={pingHistory}
              selectedCell={null}
              onCellSelect={() => { }}
              interactive={false}
              showDrop={true}
              dropCoords={getDropCoords()}
            />
          </div>
        )}
      </div>

      {/* MODALS */}
      <Modal isOpen={showHistoryModal} onClose={() => setShowHistoryModal(false)} title="Ping History">
        {pingHistory.length === 0 ? (
          <p className="text-center text-slate-500 py-8">No pings yet</p>
        ) : (
          <div className="space-y-2">
            {pingHistory.map((ping, i) => (
              <div key={i} className="flex items-center justify-between p-2 bg-black/30 rounded">
                <span className="text-xs text-slate-400">Turn {ping.turn}</span>
                <span className={`text-sm font-bold ${getZoneColor(ping.zone)}`}>{ping.zone}</span>
                <span className="text-xs text-slate-500">{ping.distance}m</span>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal isOpen={showInfoModal} onClose={() => setShowInfoModal(false)} title="Game Info">
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Session</span>
            <span className="text-slate-300 font-mono">{sessionId}</span>
          </div>
          {gameState && (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">You</span>
                <span className="text-emerald-400">{gameState.player1 === userAddress ? 'Agent 1' : 'Agent 2'}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Your Best</span>
                <span className="text-slate-300">
                  {gameState.player1 === userAddress ? gameState.player1_best_distance : gameState.player2_best_distance}m
                </span>
              </div>
            </>
          )}

          {/* Dev mode toggle */}
          <div className="pt-4 border-t border-slate-700">
            <button
              onClick={() => { setShowDebug(!showDebug); showToast(showDebug ? 'Debug off' : 'Debug on', 'info'); }}
              className="w-full py-2 text-xs text-slate-500 hover:text-red-400 transition-colors"
            >
              {showDebug ? 'Disable' : 'Enable'} Debug Mode
            </button>
            {showDebug && (
              <div className="mt-2 p-2 bg-red-900/20 rounded text-xs text-red-400">
                <p>Secret: {playerSecret ? `${playerSecret.x},${playerSecret.y}` : 'N/A'}</p>
                <button
                  onClick={handleForceTimeout}
                  disabled={loading}
                  className="mt-2 w-full py-1 bg-red-500/20 rounded hover:bg-red-500/30"
                >
                  Force Timeout
                </button>
              </div>
            )}
          </div>
        </div>
      </Modal>

      <Modal isOpen={showGameOverModal} onClose={() => setShowGameOverModal(false)}>
        <div className="text-center py-4">
          <div className={`text-3xl font-black uppercase tracking-widest mb-4 ${gameState?.winner === userAddress ? 'text-emerald-400' : 'text-red-400'
            }`}>
            {gameState?.winner === userAddress ? 'Victory' : 'Defeat'}
          </div>
          <p className="text-sm text-slate-400 mb-6">
            {gameState?.winner === userAddress ? 'You found the drop!' : 'Your opponent found the drop.'}
          </p>
          <ActionButton
            label="New Game"
            onClick={handleStartNewGame}
            variant="primary"
            fullWidth
          />
        </div>
      </Modal>

      <ToastSystem toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
