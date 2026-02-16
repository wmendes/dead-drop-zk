import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Buffer } from 'buffer';
import { Loader2, Crosshair, History, Info, Copy, Check, Volume2, VolumeX } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { DeadDropService } from './deadDropService';
import { useWallet } from '@/hooks/useWallet';
import { DEAD_DROP_CONTRACT, DEAD_DROP_PROVER_URL } from '@/utils/constants';
import type { Game } from './bindings';
import { GameStatus } from './bindings';
import { GameMap, gridToLatLng, formatLatLng } from './GameMap';
import { Modal } from './components/Modal';
import { ToastSystem } from './components/ToastSystem';
import { ActionButton } from './components/ActionPanel';
import { DeadDropLogo } from '@/components/DeadDropLogo';
import { useSoundEngine } from './useSoundEngine';
import { getSessionRandomness, provePing as provePingViaBackend } from './deadDropProofService';

const MAX_TURNS = 30;
const MODAL_PAGE_SIZE = 4;

type TemperatureZone = 'FOUND' | 'HOT' | 'WARM' | 'COOL' | 'COLD';
type GamePhase = 'create' | 'waiting_opponent' | 'my_turn' | 'opponent_turn' | 'game_over';

interface PingResult {
  turn: number;
  x: number;
  y: number;
  distance: number;
  zone: TemperatureZone;
  player: string;
}

interface DeadDropGameProps {
  userAddress: string;
  currentEpoch: number;
  availablePoints: bigint;
  initialXDR?: string | null;
  initialSessionId?: number | null;
  onStandingsRefresh: () => void;
  onGameComplete: () => void;
}

const deadDropService = new DeadDropService(DEAD_DROP_CONTRACT);

const createRandomSessionId = (): number => {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] || 1;
};

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

function toErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  try {
    const serialized = JSON.stringify(err);
    if (serialized && serialized !== '{}') return serialized;
  } catch {
    // ignore
  }
  return fallback;
}

export function DeadDropGame({
  userAddress,
  onStandingsRefresh,
  onGameComplete,
}: DeadDropGameProps) {
  const DEFAULT_POINTS = '1';
  const POINTS_DECIMALS = 7;
  const { getContractSigner, releaseDeadDropSessionSigner } = useWallet();
  const sound = useSoundEngine();

  const [sessionId, setSessionId] = useState<number>(() => createRandomSessionId());
  const [gameState, setGameState] = useState<Game | null>(null);
  const [gamePhase, setGamePhase] = useState<GamePhase>('create');
  const [pingHistory, setPingHistory] = useState<PingResult[]>([]);

  const [joinRoomCode, setJoinRoomCode] = useState('');

  const [selectedCell, setSelectedCell] = useState<{ x: number; y: number } | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [manualDropX, setManualDropX] = useState('');
  const [manualDropY, setManualDropY] = useState('');

  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [showGameOverModal, setShowGameOverModal] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [infoPage, setInfoPage] = useState(0);

  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'success' | 'info'; id: string; duration?: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const actionLock = useRef(false);
  const missingSessionNotified = useRef(false);
  const gamePhaseRef = useRef<GamePhase>('create');

  const showToast = (message: string, type: 'error' | 'success' | 'info', duration?: number) => {
    setToast({ message, type, id: crypto.randomUUID(), duration });
  };

  const handleDismissToast = useCallback(() => {
    setToast(null);
  }, []);

  const parsePoints = (value: string): bigint | null => {
    try {
      const cleaned = value.replace(/[^\d.]/g, '');
      if (!cleaned || cleaned === '.') return null;
      const [whole = '0', fraction = ''] = cleaned.split('.');
      const paddedFraction = fraction.padEnd(POINTS_DECIMALS, '0').slice(0, POINTS_DECIMALS);
      return BigInt(whole + paddedFraction);
    } catch {
      return null;
    }
  };

  const runAction = async (action: () => Promise<void>) => {
    if (actionLock.current || loading) return;
    actionLock.current = true;
    try {
      await action();
    } finally {
      actionLock.current = false;
    }
  };

  const derivePhase = useCallback((game: Game | null): GamePhase => {
    if (!game) return 'create';
    const isP1 = game.player1 === userAddress;
    const isP2 = game.player2 === userAddress;
    if (!isP1 && !isP2) return 'create';
    if (game.winner) return 'game_over';

    if (game.status === GameStatus.Active) {
      const isMyTurn = (game.whose_turn === 1 && isP1) || (game.whose_turn === 2 && isP2);
      return isMyTurn ? 'my_turn' : 'opponent_turn';
    }

    if (game.status === GameStatus.Created) {
      return 'waiting_opponent';
    }

    return 'game_over';
  }, [userAddress]);

  const mergePingEvents = useCallback((events: {
    player: string;
    turn: number;
    distance: number;
    x: number;
    y: number;
  }[]) => {
    if (!events || events.length === 0) return;

    setPingHistory(prev => {
      const next = [...prev];
      let changed = false;

      for (const evt of events) {
        const index = next.findIndex((p) => p.turn === evt.turn);
        const entry: PingResult = {
          turn: evt.turn,
          x: evt.x,
          y: evt.y,
          distance: evt.distance,
          zone: getTemperatureZone(evt.distance),
          player: evt.player,
        };

        if (index !== -1) {
          if (
            next[index].distance !== entry.distance
            || next[index].x !== entry.x
            || next[index].y !== entry.y
            || next[index].player !== entry.player
          ) {
            next[index] = entry;
            changed = true;
          }
        } else {
          next.push(entry);
          changed = true;
        }
      }

      return changed ? next.sort((a, b) => a.turn - b.turn) : prev;
    });
  }, []);

  const resetMissingSessionState = useCallback(() => {
    setGameState(null);
    setPingHistory([]);
    setSelectedCell(null);
    setStatusMessage(null);
    setLoading(false);
    setGamePhase('create');
  }, []);

  const syncFromChain = useCallback(async (reason: string) => {
    const [game, events] = await Promise.all([
      deadDropService.getGame(sessionId),
      deadDropService.getPingEvents(sessionId).catch(() => []),
    ]);

    if (!game) {
      if (gamePhaseRef.current === 'waiting_opponent') {
        const lobby = await deadDropService.getLobby(sessionId).catch(() => null);
        if (lobby) {
          missingSessionNotified.current = false;
          return;
        }
        if (!missingSessionNotified.current) {
          showToast('Lobby expired or game not found. Returning to setup.', 'info', 2500);
          missingSessionNotified.current = true;
        }
        resetMissingSessionState();
        return;
      }

      if (!missingSessionNotified.current) {
        showToast('Game not found or expired. Returning to setup.', 'info', 2500);
        missingSessionNotified.current = true;
      }
      resetMissingSessionState();
      return;
    }

    missingSessionNotified.current = false;
    mergePingEvents(events);

    const previousPhase = gamePhaseRef.current;
    const newPhase = derivePhase(game);

    setGameState(game);
    if (newPhase === 'game_over' && previousPhase !== 'game_over') {
      setShowGameOverModal(true);
      if (game.winner === userAddress) {
        void sound.playVictory();
      } else {
        void sound.playDefeat();
      }
    }
    if (newPhase === 'my_turn' && previousPhase !== 'my_turn') {
      void sound.playMyTurn();
    }
    setGamePhase(newPhase);

    if (reason === 'post-ping' && newPhase === 'my_turn') {
      setStatusMessage(null);
    }
  }, [sessionId, derivePhase, userAddress, mergePingEvents, resetMissingSessionState, sound]);

  useEffect(() => {
    gamePhaseRef.current = gamePhase;
  }, [gamePhase]);

  useEffect(() => {
    if (gamePhase === 'create') return;
    void syncFromChain('phase-change');

    const interval = setInterval(() => {
      void syncFromChain('poll');
    }, 2500);

    return () => clearInterval(interval);
  }, [gamePhase, sessionId, syncFromChain]);

  useEffect(() => {
    missingSessionNotified.current = false;
    setStatusMessage(null);
  }, [sessionId]);

  useEffect(() => {
    if (gamePhase === 'create') return;
    if (gameState && (gameState.player1 === userAddress || gameState.player2 === userAddress)) {
      return;
    }

    actionLock.current = false;
    missingSessionNotified.current = false;
    setStatusMessage(null);
    setGamePhase('create');
    setSessionId(createRandomSessionId());
    setGameState(null);
    setPingHistory([]);
    setSelectedCell(null);
    setLoading(false);
    setJoinRoomCode('');
    setCopied(false);
  }, [userAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const manualDrop = (manualDropX !== '' && manualDropY !== '')
    ? { x: Number(manualDropX) % 100, y: Number(manualDropY) % 100 }
    : null;

  const handleOpenGame = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        showToast('Opening lobby...', 'info');

        const hostPoints = parsePoints(DEFAULT_POINTS);
        if (!hostPoints || hostPoints <= 0n) throw new Error('Enter valid points');

        const signer = getContractSigner({
          preferSessionSigner: true,
          sessionContractId: DEAD_DROP_CONTRACT,
          sessionPhase: 'setup',
          sessionId,
        });
        await deadDropService.openGame(sessionId, userAddress, hostPoints, signer);

        setGamePhase('waiting_opponent');
        sound.playLobbyOpened();
        sound.startAmbient();
        onStandingsRefresh();
      } catch (err: unknown) {
        showToast(toErrorMessage(err, 'Failed to open lobby'), 'error');
      } finally {
        setLoading(false);
      }
    });
  };

  const handleJoinGame = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        showToast('Joining lobby...', 'info');

        const roomCode = parseInt(joinRoomCode.trim(), 10);
        if (isNaN(roomCode) || roomCode <= 0) throw new Error('Enter a valid room code');

        const joinerPoints = parsePoints(DEFAULT_POINTS);
        if (!joinerPoints || joinerPoints <= 0n) throw new Error('Enter valid points');
        if (!DEAD_DROP_PROVER_URL) {
          throw new Error('Dead Drop prover URL is not configured');
        }

        const lobby = await deadDropService.getLobby(roomCode);
        if (!lobby) throw new Error('Lobby not found or expired');

        const randomness = await getSessionRandomness(DEAD_DROP_PROVER_URL, roomCode);
        const signer = getContractSigner({
          preferSessionSigner: true,
          sessionContractId: DEAD_DROP_CONTRACT,
          sessionPhase: 'setup',
          sessionId: roomCode,
        });
        await deadDropService.joinGame(
          roomCode,
          userAddress,
          joinerPoints,
          {
            randomnessOutput: Buffer.from(randomness.randomnessOutputHex, 'hex'),
            dropCommitment: Buffer.from(randomness.dropCommitmentHex, 'hex'),
            randomnessSignature: Buffer.from(randomness.randomnessSignatureHex, 'hex'),
          },
          signer,
        );

        setSessionId(roomCode);
        const game = await deadDropService.getGame(roomCode);
        setGameState(game);
        setGamePhase(derivePhase(game));
        sound.playOpponentJoined();
        sound.startAmbient();
        onStandingsRefresh();
      } catch (err: unknown) {
        showToast(toErrorMessage(err, 'Failed to join game'), 'error');
      } finally {
        setLoading(false);
      }
    });
  };

  const handleSubmitPing = async () => {
    if (!selectedCell || !gameState) return;

    await runAction(async () => {
      try {
        setLoading(true);
        setStatusMessage('Generating proof...');

        const onChainGame = await deadDropService.getGame(sessionId);
        if (!onChainGame) {
          throw new Error('Game not found or expired. Reload and try again.');
        }
        if (onChainGame.player1 !== userAddress && onChainGame.player2 !== userAddress) {
          throw new Error('You are not a player in this game.');
        }
        if (!DEAD_DROP_PROVER_URL) {
          throw new Error('Dead Drop prover URL is not configured');
        }

        const submittedTurn = onChainGame.current_turn;
        const proof = await provePingViaBackend(DEAD_DROP_PROVER_URL, {
          sessionId,
          turn: submittedTurn,
          pingX: selectedCell.x,
          pingY: selectedCell.y,
        });

        const signer = getContractSigner({
          preferSessionSigner: true,
          sessionContractId: DEAD_DROP_CONTRACT,
          sessionPhase: 'gameplay',
          sessionId,
        });
        await deadDropService.submitPing(
          sessionId,
          userAddress,
          submittedTurn,
          proof.distance,
          selectedCell.x,
          selectedCell.y,
          Buffer.from(proof.proofHex, 'hex'),
          proof.publicInputsHex.map((h) => Buffer.from(h, 'hex')),
          signer,
        );

        const zone = getTemperatureZone(proof.distance);
        sound.playPingResult(zone);

        setPingHistory((prev) => {
          if (prev.some((p) => p.turn === submittedTurn)) return prev;
          return [
            ...prev,
            {
              turn: submittedTurn,
              x: selectedCell.x,
              y: selectedCell.y,
              distance: proof.distance,
              zone,
              player: userAddress,
            },
          ].sort((a, b) => a.turn - b.turn);
        });

        setSelectedCell(null);
        showToast(proof.distance === 0 ? 'DROP FOUND!' : `${zone} (${proof.distance}m)`, 'info', 2500);

        const updatedGame = await deadDropService.getGame(sessionId);
        setGameState(updatedGame);
        const newPhase = derivePhase(updatedGame);
        setGamePhase(newPhase);
        if (newPhase === 'game_over') {
          setShowGameOverModal(true);
        }
      } catch (err: unknown) {
        showToast(toErrorMessage(err, 'Failed to submit ping'), 'error');
      } finally {
        setStatusMessage(null);
        setLoading(false);
      }
    });
  };

  const handleForceTimeout = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        const signer = getContractSigner({
          preferSessionSigner: true,
          sessionContractId: DEAD_DROP_CONTRACT,
          sessionPhase: 'gameplay',
          sessionId,
        });
        await deadDropService.forceTimeout(sessionId, userAddress, signer);
        showToast('Timeout claimed', 'success');
        sound.playTimeout();
        const game = await deadDropService.getGame(sessionId);
        setGameState(game);
        setGamePhase('game_over');
        setShowGameOverModal(true);
        onStandingsRefresh();
      } catch (err: unknown) {
        showToast(toErrorMessage(err, 'Timeout not reached yet'), 'error');
      } finally {
        setLoading(false);
      }
    });
  };

  const handleStartNewGame = () => {
    releaseDeadDropSessionSigner();
    if (gameState?.winner) onGameComplete();
    sound.stopAmbient();

    actionLock.current = false;
    missingSessionNotified.current = false;

    setStatusMessage(null);
    setGamePhase('create');
    setSessionId(createRandomSessionId());
    setGameState(null);
    setPingHistory([]);
    setSelectedCell(null);
    setLoading(false);
    setJoinRoomCode('');
    setCopied(false);
    setShowDebug(false);
    setShowGameOverModal(false);
  };

  useEffect(() => {
    if (gamePhase !== 'game_over') return;
    releaseDeadDropSessionSigner();
  }, [gamePhase, releaseDeadDropSessionSigner]);

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    showToast('Copied to clipboard', 'info', 1000);
    setTimeout(() => setCopied(false), 2000);
  };

  const historyEntries = useMemo(() => [...pingHistory].reverse(), [pingHistory]);
  const historyTotalPages = Math.max(1, Math.ceil(historyEntries.length / MODAL_PAGE_SIZE));
  const historyWindowStart = historyPage * MODAL_PAGE_SIZE;
  const visibleHistoryEntries = historyEntries.slice(historyWindowStart, historyWindowStart + MODAL_PAGE_SIZE);
  const infoTotalPages = 2;

  useEffect(() => {
    setHistoryPage((prev) => Math.min(prev, historyTotalPages - 1));
  }, [historyTotalPages]);

  useEffect(() => {
    if (!showHistoryModal) return;
    setHistoryPage(0);
  }, [showHistoryModal]);

  useEffect(() => {
    if (!showInfoModal) return;
    setInfoPage(0);
  }, [showInfoModal]);

  return (
    <div className="relative h-full flex flex-col overflow-hidden">
      <div className="flex-none flex items-center justify-between px-4 py-3 bg-black/40 border-b border-emerald-500/10 z-10 backdrop-blur-sm">
        <button
          onClick={() => gamePhase !== 'create' && setShowInfoModal(true)}
          className={`p-2 transition-colors ${gamePhase === 'create' ? 'text-slate-600 cursor-default' : 'text-slate-400 hover:text-emerald-400'}`}
        >
          <Info className="w-5 h-5" />
        </button>

        {gamePhase !== 'create' && (
          <div className="text-center">
            <span className="text-[10px] text-slate-500 uppercase tracking-widest block mb-0.5">Turn</span>
            <div className="flex items-baseline justify-center gap-0.5">
              <span className="text-xl font-bold text-emerald-400 leading-none">{gameState?.current_turn ?? 0}</span>
              <span className="text-xs text-slate-600 font-medium">/{MAX_TURNS}</span>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={() => sound.toggle()}
            className="p-2 text-slate-400 hover:text-emerald-400 transition-colors"
            title={sound.enabled ? 'Mute' : 'Unmute'}
          >
            {sound.enabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
          </button>

          {gamePhase !== 'create' && (
            <button
              onClick={() => setShowHistoryModal(true)}
              className="p-2 text-slate-400 hover:text-emerald-400 transition-colors relative"
            >
              <History className="w-5 h-5" />
              {pingHistory.length > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 text-black text-[10px] font-bold rounded-full flex items-center justify-center border border-black">
                  {pingHistory.length}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col relative overflow-hidden">
        {gamePhase === 'create' && (
          <div className="flex-1 flex flex-col items-center justify-center p-6 pb-12 overflow-hidden">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              className="w-full max-w-xs space-y-8"
            >
              <div className="text-center space-y-3">
                <div className="relative mx-auto h-28 w-28">
                  <div className="absolute inset-0 rounded-full bg-emerald-400/12 blur-2xl" />
                  <div className="relative w-full h-full">
                    <DeadDropLogo
                      size={112}
                      className="mx-auto drop-shadow-[0_0_18px_rgba(52,211,153,0.35)]"
                    />
                  </div>
                  <div className="absolute inset-0 rounded-full border border-emerald-500/20 animate-ping opacity-20" />
                </div>

                <div>
                  <h1 className="text-3xl font-black text-emerald-400 uppercase tracking-[0.2em] drop-shadow-sm">Dead Drop</h1>
                  <p className="text-xs text-slate-500 font-medium tracking-wide mt-1">Find the secret location</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-5 pt-2"
              >
                <ActionButton
                  label="Open Lobby"
                  onClick={handleOpenGame}
                  loading={loading}
                  variant="primary"
                  fullWidth
                  icon={<Crosshair className="w-4 h-4" />}
                />

                <div className="h-px bg-gradient-to-r from-transparent via-emerald-500/20 to-transparent" />

                <div className="space-y-2">
                  <label className="block text-[10px] uppercase tracking-widest text-slate-400 font-bold ml-1">Room Code</label>
                  <div className="relative group">
                    <input
                      type="text"
                      value={joinRoomCode}
                      onChange={(e) => setJoinRoomCode(e.target.value)}
                      placeholder="ENTER CODE"
                      disabled={loading}
                      className="w-full h-12 px-4 bg-black/50 border border-emerald-500/20 rounded-lg text-center text-lg font-mono text-emerald-400 placeholder-slate-700 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 transition-all uppercase tracking-widest"
                    />
                    <div className="absolute inset-0 border border-transparent group-hover:border-emerald-500/10 rounded-lg pointer-events-none transition-colors" />
                  </div>
                </div>

                <ActionButton
                  label="Join Game"
                  onClick={handleJoinGame}
                  loading={loading}
                  variant="default"
                  fullWidth
                  icon={<Crosshair className="w-4 h-4" />}
                />
              </motion.div>
            </motion.div>
          </div>
        )}

        {gamePhase === 'waiting_opponent' && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 pb-20">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full max-w-xs text-center flex flex-col items-center gap-8"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-cyan-500/20 blur-xl rounded-full animate-pulse" />
                <Loader2 className="relative w-16 h-16 text-cyan-400 animate-spin drop-shadow-[0_0_10px_rgba(34,211,238,0.5)]" />
              </div>

              <div className="space-y-2">
                <h2 className="text-xl font-bold text-cyan-400 uppercase tracking-widest drop-shadow-sm">Waiting for Opponent</h2>
                <p className="text-xs text-slate-500 font-medium">Share this room code to start</p>
              </div>

              <div className="w-full bg-black/60 rounded-xl p-6 border border-cyan-500/20 shadow-[0_0_20px_rgba(0,0,0,0.3)] group relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent opacity-50" />
                <div className="text-[10px] text-slate-500 uppercase tracking-[0.2em] mb-3 font-bold">Room Code</div>
                <div className="text-4xl font-black text-cyan-400 font-mono mb-6 tracking-widest drop-shadow-[0_0_8px_rgba(34,211,238,0.3)] select-all">
                  {sessionId}
                </div>
                <button
                  onClick={() => copyToClipboard(sessionId.toString())}
                  className="w-full py-3 px-4 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg text-xs font-bold text-cyan-400 uppercase tracking-wider transition-all flex items-center justify-center gap-2 group-hover:border-cyan-500/50"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? 'Copied to Clipboard' : 'Copy Code'}
                </button>
              </div>

              <div className="w-full pt-4">
                <ActionButton
                  label="Cancel Lobby"
                  onClick={handleStartNewGame}
                  variant="default"
                  fullWidth
                />
              </div>
            </motion.div>
          </div>
        )}

        {(gamePhase === 'my_turn' || gamePhase === 'opponent_turn') && (
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            <div className="flex-1 relative w-full h-full">
              <div className="absolute inset-0">
                <GameMap
                  pingHistory={pingHistory}
                  selectedCell={selectedCell}
                  onCellSelect={setSelectedCell}
                  interactive={gamePhase === 'my_turn'}
                  showDrop={showDebug}
                  dropCoords={showDebug ? manualDrop : null}
                  userAddress={userAddress}
                />
              </div>

              <AnimatePresence>
                {gamePhase === 'opponent_turn' && (
                  <motion.div
                    initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
                    animate={{ opacity: 1, backdropFilter: 'blur(2px)' }}
                    exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
                    className="absolute inset-0 bg-black/40 z-20 flex flex-col items-center justify-center pointer-events-none"
                  >
                    <div className="bg-black/80 border border-slate-700/50 px-6 py-4 rounded-xl flex flex-col items-center gap-3 backdrop-blur-md shadow-2xl">
                      <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
                      <p className="text-xs font-bold text-slate-300 uppercase tracking-widest">
                        {statusMessage || "Opponent's turn"}
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <AnimatePresence>
              {gamePhase === 'my_turn' && selectedCell && (
                <motion.div
                  initial={{ y: '100%' }}
                  animate={{ y: 0 }}
                  exit={{ y: '100%' }}
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  className="z-30 bg-black/90 border-t border-emerald-500/30 backdrop-blur-xl pb-safe"
                >
                  <div className="p-4 space-y-3">
                    <div className="flex items-end justify-between px-1">
                      <div>
                        <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold block mb-1">Target Coordinates</span>
                        <span className="text-xl font-mono font-bold text-emerald-400 tracking-tight flex items-baseline gap-2">
                          {formatLatLng(gridToLatLng(selectedCell.x, selectedCell.y).lat, gridToLatLng(selectedCell.x, selectedCell.y).lng)}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] text-emerald-500/70 uppercase tracking-widest font-bold">Ready</span>
                      </div>
                    </div>

                    <ActionButton
                      label="INITIATE PING"
                      onClick={handleSubmitPing}
                      loading={loading}
                      variant="primary"
                      icon={<Crosshair className="w-5 h-5" />}
                      fullWidth
                    />

                    <ActionButton
                      label="CLAIM TIMEOUT"
                      onClick={handleForceTimeout}
                      loading={loading}
                      variant="default"
                      fullWidth
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {gamePhase === 'game_over' && (
          <div className="flex-1 relative w-full h-full">
            <div className="absolute inset-0 grayscale-[50%]">
              <GameMap
                pingHistory={pingHistory}
                selectedCell={null}
                onCellSelect={() => { }}
                interactive={false}
                showDrop={showDebug}
                dropCoords={showDebug ? manualDrop : null}
                userAddress={userAddress}
              />
            </div>
            <div className="absolute inset-0 bg-black/60 pointer-events-none" />
          </div>
        )}
      </div>

      <Modal isOpen={showHistoryModal} onClose={() => setShowHistoryModal(false)} title="Mission Log">
        <div className="flex h-full min-h-0 flex-col">
          {historyEntries.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-8 text-slate-600 gap-3">
              <History className="w-8 h-8 opacity-50" />
              <p className="text-xs uppercase tracking-widest">No activity recorded</p>
            </div>
          ) : (
            <>
              <div className="px-1 pb-2">
                <p className="text-[10px] text-amber-300/80 uppercase tracking-wide">
                  Ping coordinates are public. Fairness comes from proof-verified distance checks.
                </p>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto spy-scrollbar pr-1 grid gap-2 content-start">
                {visibleHistoryEntries.map((ping, i) => {
                  const isMe = ping.player === userAddress;
                  return (
                    <div key={`${ping.turn}-${i}`} className={`flex items-center justify-between p-3 border rounded-lg ${isMe ? 'bg-emerald-500/5 border-emerald-500/15' : 'bg-amber-500/5 border-amber-500/15'}`}>
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-500 uppercase tracking-wide font-bold">Turn {ping.turn}</span>
                          <span className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${isMe ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
                            {isMe ? 'You' : 'Opp'}
                          </span>
                        </div>
                        <span className="font-mono text-xs text-slate-300">
                          {formatLatLng(gridToLatLng(ping.x, ping.y).lat, gridToLatLng(ping.x, ping.y).lng)}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className={`block text-xs font-bold uppercase tracking-wider mb-0.5 ${getZoneColor(ping.zone)} drop-shadow-sm`}>
                          {ping.zone}
                        </span>
                        <span className="text-[10px] text-slate-500 font-mono">{ping.distance}m</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="pt-3 mt-2 border-t border-slate-700/70 flex items-center justify-between">
                <button
                  className="px-3 py-1.5 text-[10px] uppercase tracking-wider rounded border border-slate-700 text-slate-300 disabled:text-slate-600 disabled:border-slate-800"
                  onClick={() => setHistoryPage((prev) => Math.max(0, prev - 1))}
                  disabled={historyPage <= 0}
                >
                  Prev
                </button>
                <span className="text-[10px] text-slate-500 uppercase tracking-widest">
                  Page {historyPage + 1}/{historyTotalPages}
                </span>
                <button
                  className="px-3 py-1.5 text-[10px] uppercase tracking-wider rounded border border-slate-700 text-slate-300 disabled:text-slate-600 disabled:border-slate-800"
                  onClick={() => setHistoryPage((prev) => Math.min(historyTotalPages - 1, prev + 1))}
                  disabled={historyPage >= historyTotalPages - 1}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal isOpen={showInfoModal} onClose={() => setShowInfoModal(false)} title="Game Info">
        <div className="flex h-full min-h-0 flex-col">
          {infoPage === 0 ? (
            <div className="flex-1 min-h-0 space-y-3 overflow-y-auto spy-scrollbar pr-1">
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
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">Current Turn</span>
                    <span className="text-slate-300">{gameState.current_turn}</span>
                  </div>
                </>
              )}
              <div className="p-3 rounded border border-slate-700/70 bg-slate-800/30 text-xs text-slate-400">
                Ping coordinates are public. Fairness is enforced by on-chain proof verification.
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 space-y-3 overflow-y-auto spy-scrollbar pr-1">
              <button
                onClick={() => {
                  setShowDebug(!showDebug);
                  showToast(showDebug ? 'Debug disabled' : 'Debug enabled', 'info', 1000);
                }}
                className="w-full py-2 text-xs text-slate-500 hover:text-red-400 transition-colors border border-slate-700 rounded"
              >
                {showDebug ? 'Disable' : 'Enable'} Debug Mode
              </button>

              {showDebug && (
                <div className="p-2 bg-red-900/20 rounded text-xs text-red-400 space-y-2 border border-red-500/20">
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-400 text-[11px]">Drop:</span>
                    <input
                      type="number"
                      min={0}
                      max={99}
                      value={manualDropX}
                      onChange={(e) => setManualDropX(e.target.value)}
                      placeholder="X"
                      className="w-12 bg-white/10 border border-white/20 rounded px-1.5 py-1 text-white text-[11px]"
                    />
                    <input
                      type="number"
                      min={0}
                      max={99}
                      value={manualDropY}
                      onChange={(e) => setManualDropY(e.target.value)}
                      placeholder="Y"
                      className="w-12 bg-white/10 border border-white/20 rounded px-1.5 py-1 text-white text-[11px]"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="pt-3 mt-2 border-t border-slate-700/70 flex items-center justify-between">
            <button
              className="px-3 py-1.5 text-[10px] uppercase tracking-wider rounded border border-slate-700 text-slate-300 disabled:text-slate-600 disabled:border-slate-800"
              onClick={() => setInfoPage((prev) => Math.max(0, prev - 1))}
              disabled={infoPage <= 0}
            >
              Prev
            </button>
            <span className="text-[10px] text-slate-500 uppercase tracking-widest">
              Page {infoPage + 1}/{infoTotalPages}
            </span>
            <button
              className="px-3 py-1.5 text-[10px] uppercase tracking-wider rounded border border-slate-700 text-slate-300 disabled:text-slate-600 disabled:border-slate-800"
              onClick={() => setInfoPage((prev) => Math.min(infoTotalPages - 1, prev + 1))}
              disabled={infoPage >= infoTotalPages - 1}
            >
              Next
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showGameOverModal} onClose={() => setShowGameOverModal(false)} title="Mission Complete">
        <div className="space-y-4">
          <p className="text-sm text-slate-300">
            {gameState?.winner === userAddress ? 'You won this mission.' : 'Mission complete. Better luck next round.'}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <ActionButton label="Close" onClick={() => setShowGameOverModal(false)} variant="default" fullWidth />
            <ActionButton label="New Game" onClick={handleStartNewGame} variant="primary" fullWidth />
          </div>
        </div>
      </Modal>

      <ToastSystem toast={toast} onDismiss={handleDismissToast} />
    </div>
  );
}
