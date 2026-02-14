import { useState, useEffect, useRef, useCallback } from 'react';
import { DeadDropService } from './deadDropService';
import { useWallet } from '@/hooks/useWallet';
import { devWalletService } from '@/services/devWalletService';
import { DEAD_DROP_CONTRACT, DEAD_DROP_PROVER_URL } from '@/utils/constants';
import { getFundedSimulationSourceAddress } from '@/utils/simulationUtils';
import { Buffer } from 'buffer';
import type { Game } from './bindings';
import { GameStatus } from './bindings';
import { GameMap, gridToLatLng, formatLatLng } from './GameMap';
import { Modal } from './components/Modal';
import { ToastSystem } from './components/ToastSystem';
import { ActionButton } from './components/ActionPanel';
import { Loader2, Crosshair, History, Info, Target, Copy, Check, Volume2, VolumeX } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSoundEngine } from './useSoundEngine';
import { computeCommitmentNoir, provePingNoir } from './deadDropNoirService';
import { provePing as provePingViaBackend } from './deadDropProofService';
import {
  type RelayProofArtifacts,
} from './deadDropRelayService';
import { DeadDropWebRtcPeer, type WebRtcPingRequest } from './deadDropWebRtcService';
import { DeadDropSessionPushClient } from './deadDropSessionPushService';

const GRID_SIZE = 100;
const MAX_TURNS = 30;

type TemperatureZone = 'FOUND' | 'HOT' | 'WARM' | 'COOL' | 'COLD';
type CoordVisibility = 'exact' | 'unknown';

interface PingResult {
  turn: number;
  x: number;
  y: number;
  distance: number;
  zone: TemperatureZone;
  player: string;
  coordVisibility: CoordVisibility;
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
  const hex = await computeCommitmentNoir(secret.x, secret.y, secret.salt);
  return Buffer.from(hex, 'hex');
}

/** Safely convert Soroban SDK commitment values to Buffer (handles various runtime shapes). */
function toBuffer(v: any): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (v?.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
  if (typeof v === 'string') return Buffer.from(v, 'hex');
  if (Array.isArray(v)) return Buffer.from(v);
  throw new Error(`Cannot convert commitment to Buffer: ${typeof v}`);
}

function generateSecret(): PlayerSecret {
  const coords = new Uint32Array(2);
  crypto.getRandomValues(coords);
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  return { x: coords[0] % GRID_SIZE, y: coords[1] % GRID_SIZE, salt };
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

type GamePhase = 'create' | 'waiting_opponent' | 'commit' | 'waiting_commit' | 'my_turn' | 'opponent_turn' | 'game_over';

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

function isProverSchemaMismatchError(err: unknown): boolean {
  const message = toErrorMessage(err, '').toLowerCase();
  return message.includes('dead drop prover api mismatch')
    || message.includes('a_x must be uint32')
    || message.includes('b_x must be uint32')
    || message.includes('commitment_a_hex')
    || message.includes('commitment_b_hex');
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

export function DeadDropGame({
  userAddress,
  availablePoints,
  onStandingsRefresh,
  onGameComplete
}: DeadDropGameProps) {
  const DEFAULT_POINTS = '1';
  const POINTS_DECIMALS = 7;
  const { getContractSigner } = useWallet();
  const sound = useSoundEngine();

  const [sessionId, setSessionId] = useState<number>(() => createRandomSessionId());
  const [gameState, setGameState] = useState<Game | null>(null);
  const [gamePhase, setGamePhase] = useState<GamePhase>('create');
  const [playerSecret, setPlayerSecret] = useState<PlayerSecret | null>(null);
  const [pingHistory, setPingHistory] = useState<PingResult[]>([]);

  const [createMode, setCreateMode] = useState<'create' | 'import' | 'load' | 'join'>('create');
  const [exportedAuthEntryXDR, setExportedAuthEntryXDR] = useState<string | null>(null);
  const [importAuthEntryXDR, setImportAuthEntryXDR] = useState('');
  const [importPlayer2Points, setImportPlayer2Points] = useState(DEFAULT_POINTS);
  const [loadSessionId, setLoadSessionId] = useState('');
  const [joinRoomCode, setJoinRoomCode] = useState('');

  const [selectedCell, setSelectedCell] = useState<{ x: number; y: number } | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [copiedCoords, setCopiedCoords] = useState(false);
  const [manualOppX, setManualOppX] = useState('');
  const [manualOppY, setManualOppY] = useState('');

  // Modals
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [showGameOverModal, setShowGameOverModal] = useState(false);

  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'success' | 'info'; id: string; duration?: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [relayStatusMessage, setRelayStatusMessage] = useState<string | null>(null);
  const [isWebRtcReady, setIsWebRtcReady] = useState(false);

  const actionLock = useRef(false);
  const relayResponderBusy = useRef(false);
  const missingSessionNotified = useRef(false);
  const webRtcPeerRef = useRef<DeadDropWebRtcPeer | null>(null);
  const sessionPushRef = useRef<DeadDropSessionPushClient | null>(null);
  const pendingPushProofRequests = useRef<Map<string, {
    resolve: (proof: RelayProofArtifacts) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>>(new Map());
  const gameStateRef = useRef<Game | null>(null);
  const gamePhaseRef = useRef<GamePhase>('create');
  const playerSecretRef = useRef<PlayerSecret | null>(null);
  const soundCallbacksRef = useRef({
    playVictory: sound.playVictory,
    playDefeat: sound.playDefeat,
    playMyTurn: sound.playMyTurn,
  });

  useEffect(() => {
    soundCallbacksRef.current = {
      playVictory: sound.playVictory,
      playDefeat: sound.playDefeat,
      playMyTurn: sound.playMyTurn,
    };
  });

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    gamePhaseRef.current = gamePhase;
  }, [gamePhase]);

  useEffect(() => {
    playerSecretRef.current = playerSecret;
  }, [playerSecret]);

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

    const emptyCommitment = Buffer.alloc(32, 0);

    const myCommitmentEmpty = isP1
      ? toBuffer(game.commitment1).equals(emptyCommitment)
      : toBuffer(game.commitment2).equals(emptyCommitment);

    const isPreActive = game.status === GameStatus.Created || game.status === GameStatus.Committing;
    const isActive = game.status === GameStatus.Active;

    if (isPreActive && myCommitmentEmpty) return 'commit';
    if (isPreActive) return 'waiting_commit';
    if (isActive) {
      const isMyTurn = (game.whose_turn === 1 && isP1) || (game.whose_turn === 2 && isP2);
      return isMyTurn ? 'my_turn' : 'opponent_turn';
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
        const index = next.findIndex(p => p.turn === evt.turn);
        const isOwnPing = evt.player === userAddress;
        const playerSecret = isOwnPing ? playerSecretRef.current : null;
        const hasExactCoords = !!playerSecret;
        const resolvedX = playerSecret ? (evt.x + playerSecret.x) % GRID_SIZE : evt.x;
        const resolvedY = playerSecret ? (evt.y + playerSecret.y) % GRID_SIZE : evt.y;
        const coordVisibility: CoordVisibility = hasExactCoords ? 'exact' : 'unknown';
        const entry = {
          turn: evt.turn,
          x: resolvedX,
          y: resolvedY,
          distance: evt.distance,
          zone: getTemperatureZone(evt.distance),
          player: evt.player,
          coordVisibility,
        };
        if (index !== -1) {
          if (
            next[index].distance !== entry.distance
            || next[index].x !== entry.x
            || next[index].y !== entry.y
            || next[index].player !== entry.player
            || next[index].coordVisibility !== entry.coordVisibility
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
  }, [userAddress]);

  const resetMissingSessionState = useCallback(() => {
    setGameState(null);
    setPingHistory([]);
    setSelectedCell(null);
    setRelayStatusMessage(null);
    setLoading(false);
    setGamePhase('create');
  }, []);

  const syncFromChain = useCallback(async (reason: string) => {
    const [game, events] = await Promise.all([
      deadDropService.getGame(sessionId),
      deadDropService.getPingEvents(sessionId).catch(() => [])
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
        void soundCallbacksRef.current.playVictory();
      } else {
        void soundCallbacksRef.current.playDefeat();
      }
    }
    if (newPhase === 'my_turn' && previousPhase !== 'my_turn') {
      void soundCallbacksRef.current.playMyTurn();
    }
    setGamePhase(newPhase);

    if (reason === 'push-hint' && newPhase === 'my_turn') {
      setRelayStatusMessage(null);
    }
  }, [sessionId, derivePhase, userAddress, mergePingEvents, resetMissingSessionState]);

  useEffect(() => {
    if (gamePhase === 'create') return;
    void syncFromChain('phase-change');
  }, [sessionId, gamePhase, syncFromChain]);

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

  useEffect(() => {
    relayResponderBusy.current = false;
    missingSessionNotified.current = false;
    webRtcPeerRef.current?.close();
    webRtcPeerRef.current = null;
    sessionPushRef.current?.close();
    sessionPushRef.current = null;
    for (const pending of pendingPushProofRequests.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Session changed'));
    }
    pendingPushProofRequests.current.clear();
    setIsWebRtcReady(false);
    setRelayStatusMessage(null);
  }, [sessionId]);

  // Reset game state when the active player address changes and they are not in the current game
  useEffect(() => {
    if (gamePhase === 'create') return; // already on create screen, nothing to do
    if (gameState && (gameState.player1 === userAddress || gameState.player2 === userAddress)) {
      return; // new address is a participant in the running game — keep state
    }
    // New address is not a participant (or no game exists yet) — reset to create
    actionLock.current = false;
    relayResponderBusy.current = false;
    missingSessionNotified.current = false;
    webRtcPeerRef.current?.close();
    webRtcPeerRef.current = null;
    sessionPushRef.current?.close();
    sessionPushRef.current = null;
    for (const pending of pendingPushProofRequests.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Player switched'));
    }
    pendingPushProofRequests.current.clear();
    setIsWebRtcReady(false);
    setRelayStatusMessage(null);
    setGamePhase('create');
    setSessionId(createRandomSessionId());
    setGameState(null);
    setPlayerSecret(null);
    setPingHistory([]);
    setSelectedCell(null);
    setLoading(false);
    setExportedAuthEntryXDR(null);
    setCopied(false);
    setCreateMode('create');
  }, [userAddress]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const manualDrop = (manualOppX !== '' && manualOppY !== '' && playerSecret)
    ? { x: (playerSecret.x + Number(manualOppX)) % GRID_SIZE, y: (playerSecret.y + Number(manualOppY)) % GRID_SIZE }
    : null;

  const buildWebRtcProofResponse = useCallback(async (
    request: WebRtcPingRequest
  ): Promise<RelayProofArtifacts> => {
    if (!DEAD_DROP_PROVER_URL) {
      throw new Error('Prover URL is not configured');
    }

    const currentSecret = playerSecretRef.current;
    if (!currentSecret) {
      throw new Error('Missing game state or local secret for WebRTC proof');
    }
    if (request.sessionId !== sessionId) {
      throw new Error('Session mismatch for incoming WebRTC ping request');
    }
    const onChainGame = await deadDropService.getGame(request.sessionId);
    if (!onChainGame) {
      throw new Error('Game not found for incoming WebRTC ping request');
    }
    if (onChainGame.player1 !== userAddress && onChainGame.player2 !== userAddress) {
      throw new Error('Current player is not part of this game session');
    }
    if (request.turn !== onChainGame.current_turn) {
      throw new Error('Turn mismatch for incoming WebRTC ping request');
    }

    // Responder is the current player (me). Proof uses only responder secret +
    // pinger-provided partial offsets.
    const isResponderP1 = onChainGame.player1 === userAddress;
    const responderCommitmentHex = toBuffer(
      isResponderP1 ? onChainGame.commitment1 : onChainGame.commitment2
    ).toString('hex');
    const responderSaltHex = Buffer.from(currentSecret.salt).toString('hex');

    setRelayStatusMessage('Generating ZK proof on server (~15s)...');
    try {
      const result = await provePingViaBackend(DEAD_DROP_PROVER_URL, {
        sessionId: request.sessionId,
        turn: request.turn,
        partialDx: request.partialDx,
        partialDy: request.partialDy,
        responderX: currentSecret.x,
        responderY: currentSecret.y,
        responderSaltHex,
        responderCommitmentHex,
      });
      return {
        distance: result.distance,
        proofHex: result.proofHex,
        publicInputsHex: result.publicInputsHex,
      };
    } finally {
      setRelayStatusMessage(null);
    }
  }, [sessionId, userAddress]);

  useEffect(() => {
    const currentGame = gameState;
    if (!DEAD_DROP_PROVER_URL || !currentGame || !playerSecret) {
      webRtcPeerRef.current?.close();
      webRtcPeerRef.current = null;
      setIsWebRtcReady(false);
      return;
    }

    if (currentGame.player1 !== userAddress && currentGame.player2 !== userAddress) {
      return;
    }

    const opponentAddress = currentGame.player1 === userAddress
      ? currentGame.player2
      : currentGame.player1;

    const peer = new DeadDropWebRtcPeer({
      proverUrl: DEAD_DROP_PROVER_URL,
      sessionId,
      selfAddress: userAddress,
      peerAddress: opponentAddress,
    });

    webRtcPeerRef.current?.close();
    webRtcPeerRef.current = peer;
    setIsWebRtcReady(false);

    let cancelled = false;
    void peer.connect(buildWebRtcProofResponse)
      .then(() => {
        if (!cancelled) {
          setIsWebRtcReady(true);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setIsWebRtcReady(false);
        console.warn('WebRTC relay connection unavailable; using HTTP relay fallback', err);
      });

    return () => {
      cancelled = true;
      if (webRtcPeerRef.current === peer) {
        webRtcPeerRef.current = null;
      }
      peer.close();
      setIsWebRtcReady(false);
    };
  }, [
    sessionId,
    userAddress,
    gameState?.player1,
    gameState?.player2,
    playerSecret,
    buildWebRtcProofResponse,
  ]);

  const rejectPendingPushProofRequests = useCallback((message: string) => {
    for (const pending of pendingPushProofRequests.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    pendingPushProofRequests.current.clear();
  }, []);

  const requestProofViaSessionPush = useCallback(async (
    opponentAddress: string,
    request: WebRtcPingRequest,
  ): Promise<RelayProofArtifacts> => {
    const client = sessionPushRef.current;
    if (!client || !client.isOpen()) {
      throw new Error('Session push channel is not connected');
    }

    const requestId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `proof-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

    return new Promise<RelayProofArtifacts>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingPushProofRequests.current.delete(requestId);
        reject(new Error('Timed out waiting for push proof response'));
      }, 120_000);

      pendingPushProofRequests.current.set(requestId, { resolve, reject, timer });
      client.sendDirect(opponentAddress, 'proof.request', {
        request_id: requestId,
        session_id: request.sessionId,
        turn: request.turn,
        partial_dx: request.partialDx,
        partial_dy: request.partialDy,
      });
    });
  }, []);

  const sendPushDirectBestEffort = useCallback(async (
    to: string,
    event: string,
    payload: unknown,
  ) => {
    if (!DEAD_DROP_PROVER_URL) return;
    const existing = sessionPushRef.current;
    if (existing && existing.isOpen()) {
      existing.sendDirect(to, event, payload);
      return;
    }

    const temp = new DeadDropSessionPushClient({
      proverUrl: DEAD_DROP_PROVER_URL,
      sessionId,
      selfAddress: userAddress,
    });
    try {
      await temp.connect();
      temp.sendDirect(to, event, payload);
    } finally {
      temp.close();
    }
  }, [sessionId, userAddress]);

  useEffect(() => {
    if (!DEAD_DROP_PROVER_URL || gamePhase === 'create') {
      sessionPushRef.current?.close();
      sessionPushRef.current = null;
      rejectPendingPushProofRequests('Session push channel closed');
      return;
    }

    const client = new DeadDropSessionPushClient({
      proverUrl: DEAD_DROP_PROVER_URL,
      sessionId,
      selfAddress: userAddress,
      onReady: (peers) => {
        if (peers.length > 0) {
          void syncFromChain('push-hint');
        }
      },
      onPeerJoined: () => {
        void syncFromChain('push-hint');
      },
      onDirect: (message) => {
        if (message.event === 'proof.request') {
          if (relayResponderBusy.current) return;
          const payload = message.payload as any;
          const requestId = String(payload?.request_id || '');
          const incomingRequest: WebRtcPingRequest = {
            sessionId: Number(payload?.session_id),
            turn: Number(payload?.turn),
            partialDx: Number(payload?.partial_dx),
            partialDy: Number(payload?.partial_dy),
          };
          if (
            !requestId
            || !Number.isInteger(incomingRequest.sessionId)
            || !Number.isInteger(incomingRequest.turn)
            || !Number.isInteger(incomingRequest.partialDx)
            || !Number.isInteger(incomingRequest.partialDy)
            || incomingRequest.partialDx < 0
            || incomingRequest.partialDx >= GRID_SIZE
            || incomingRequest.partialDy < 0
            || incomingRequest.partialDy >= GRID_SIZE
          ) {
            return;
          }

          relayResponderBusy.current = true;
          void buildWebRtcProofResponse(incomingRequest)
            .then((proof) => {
              if (!client.isOpen()) return;
              client.sendDirect(message.from, 'proof.response', {
                request_id: requestId,
                proof,
              });
            })
            .catch((err: unknown) => {
              if (!client.isOpen()) return;
              client.sendDirect(message.from, 'proof.error', {
                request_id: requestId,
                error: toErrorMessage(err, 'Failed to generate proof'),
              });
            })
            .finally(() => {
              relayResponderBusy.current = false;
            });
          return;
        }

        if (message.event === 'proof.response') {
          const payload = message.payload as any;
          const requestId = String(payload?.request_id || '');
          if (!requestId) return;
          const pending = pendingPushProofRequests.current.get(requestId);
          if (!pending) return;
          pendingPushProofRequests.current.delete(requestId);
          clearTimeout(pending.timer);
          const proof = payload?.proof as RelayProofArtifacts | undefined;
          if (!proof || !Number.isInteger(proof.distance)) {
            pending.reject(new Error('Invalid proof response payload'));
            return;
          }
          pending.resolve(proof);
          return;
        }

        if (message.event === 'proof.error') {
          const payload = message.payload as any;
          const requestId = String(payload?.request_id || '');
          if (!requestId) return;
          const pending = pendingPushProofRequests.current.get(requestId);
          if (!pending) return;
          pendingPushProofRequests.current.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(new Error(String(payload?.error || 'Peer failed to produce proof')));
          return;
        }

        if (message.event === 'lobby.joined' || message.event === 'game.hint') {
          const payload = message.payload as any;
          if (payload?.ping) {
            const ping = payload.ping;
            if (
              Number.isInteger(ping.turn)
              && Number.isInteger(ping.x)
              && Number.isInteger(ping.y)
              && Number.isInteger(ping.distance)
              && typeof ping.player === 'string'
            ) {
              mergePingEvents([{
                player: ping.player,
                turn: ping.turn,
                distance: ping.distance,
                x: ping.x,
                y: ping.y,
              }]);
            }
          }
          void syncFromChain('push-hint');
        }
      },
      onBroadcast: (message) => {
        if (message.event === 'lobby.joined' || message.event === 'game.hint') {
          const payload = message.payload as any;
          if (payload?.ping) {
            const ping = payload.ping;
            if (
              Number.isInteger(ping.turn)
              && Number.isInteger(ping.x)
              && Number.isInteger(ping.y)
              && Number.isInteger(ping.distance)
              && typeof ping.player === 'string'
            ) {
              mergePingEvents([{
                player: ping.player,
                turn: ping.turn,
                distance: ping.distance,
                x: ping.x,
                y: ping.y,
              }]);
            }
          }
          void syncFromChain('push-hint');
        }
      },
      onError: (error) => {
        console.warn('Session push channel warning:', error);
      },
    });

    sessionPushRef.current?.close();
    sessionPushRef.current = client;

    let cancelled = false;
    void client.connect().catch((err: unknown) => {
      if (cancelled) return;
      console.warn('Failed to connect session push channel:', err);
    });

    return () => {
      cancelled = true;
      if (sessionPushRef.current === client) {
        sessionPushRef.current = null;
      }
      client.close();
      rejectPendingPushProofRequests('Session push channel closed');
    };
  }, [
    gamePhase,
    sessionId,
    userAddress,
    buildWebRtcProofResponse,
    mergePingEvents,
    syncFromChain,
    rejectPendingPushProofRequests,
  ]);

  // Actions
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
        // showToast('Game started!', 'success'); // Redundant with UI change
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
        sound.startAmbient();
        // showToast('Game loaded!', 'success'); // Redundant
      } catch (err: any) {
        showToast(err.message || 'Failed to load', 'error');
      } finally { setLoading(false); }
    });
  };

  const handleOpenGame = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        showToast('Opening lobby...', 'info');

        const hostPoints = parsePoints(DEFAULT_POINTS);
        if (!hostPoints || hostPoints <= 0n) throw new Error('Enter valid points');

        const signer = getContractSigner();
        await deadDropService.openGame(sessionId, userAddress, hostPoints, signer);

        setGamePhase('waiting_opponent');
        sound.playLobbyOpened();
        sound.startAmbient();
        onStandingsRefresh();
        // showToast('Lobby opened! Share the room code: ' + sessionId, 'success'); // Redundant with UI
      } catch (err: unknown) {
        showToast(toErrorMessage(err, 'Failed to open lobby'), 'error');
      } finally { setLoading(false); }
    });
  };

  const handleJoinGame = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        showToast('Joining lobby...', 'info');

        const roomCode = parseInt(joinRoomCode.trim());
        if (isNaN(roomCode) || roomCode <= 0) throw new Error('Enter a valid room code');

        const joinerPoints = parsePoints(DEFAULT_POINTS);
        if (!joinerPoints || joinerPoints <= 0n) throw new Error('Enter valid points');

        // Check if lobby exists
        const lobby = await deadDropService.getLobby(roomCode);
        if (!lobby) throw new Error('Lobby not found or expired');

        const signer = getContractSigner();
        await deadDropService.joinGame(roomCode, userAddress, joinerPoints, signer);

        setSessionId(roomCode);
        const game = await deadDropService.getGame(roomCode);
        setGameState(game);
        setGamePhase('commit');
        void sendPushDirectBestEffort(lobby.host, 'lobby.joined', {
          session_id: roomCode,
        });
        sound.playOpponentJoined();
        sound.startAmbient();
        onStandingsRefresh();
        // showToast('Joined game!', 'success'); // Redundant
      } catch (err: any) {
        showToast(err.message || 'Failed to join game', 'error');
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
        showToast('Secret committed', 'success', 1500);
        sound.playCommitSecret();
        const game = await deadDropService.getGame(sessionId);
        setGameState(game); setGamePhase(derivePhase(game));
        if (game) {
          const opponentAddress = game.player1 === userAddress ? game.player2 : game.player1;
          void sendPushDirectBestEffort(opponentAddress, 'game.hint', {
            type: 'commit',
            session_id: sessionId,
          });
        }
      } catch (err: any) {
        showToast(err.message || 'Failed to commit', 'error');
      } finally { setLoading(false); }
    });
  };

  const handleSubmitPing = async () => {
    if (!selectedCell || !gameState || !playerSecret) return;
    await runAction(async () => {
      try {
        setLoading(true);
        const onChainGame = await deadDropService.getGame(sessionId);
        if (!onChainGame) {
          throw new Error('Game not found or expired. Reload and try again.');
        }
        if (onChainGame.player1 !== userAddress && onChainGame.player2 !== userAddress) {
          throw new Error('You are not a player in this game.');
        }

        const submittedTurn = onChainGame.current_turn;
        const isP1 = onChainGame.player1 === userAddress;
        const opponentAddr = isP1 ? onChainGame.player2 : onChainGame.player1;
        const opponentSecret = getOpponentSecret(sessionId, opponentAddr);

        // Nuclear-keys partial offsets:
        // partial = (ping - pinger_secret) mod GRID_SIZE
        const partialDx = (selectedCell.x + GRID_SIZE - playerSecret.x) % GRID_SIZE;
        const partialDy = (selectedCell.y + GRID_SIZE - playerSecret.y) % GRID_SIZE;
        const pingRequest = {
          sessionId,
          turn: submittedTurn,
          partialDx,
          partialDy,
        };

        // Responder commitment for this turn:
        // - P1 turn => responder is P2
        // - P2 turn => responder is P1
        const responderCommitmentHex = toBuffer(
          isP1 ? onChainGame.commitment2 : onChainGame.commitment1
        ).toString('hex');

        let distance: number;
        let proofBuf: Buffer;
        let publicInputsBufs: Buffer[];

        if (DEAD_DROP_PROVER_URL) {
          setRelayStatusMessage(isWebRtcReady
            ? 'Requesting proof over direct channel...'
            : 'Requesting proof over push channel...');
          try {
            let proof: RelayProofArtifacts | null = null;

            const webRtcPeer = webRtcPeerRef.current;
            if (webRtcPeer?.isReady()) {
              try {
                proof = await webRtcPeer.requestProof(pingRequest);
              } catch (webRtcErr: unknown) {
                console.warn('WebRTC proof request failed, falling back to push channel', webRtcErr);
              }
            }

            if (!proof) {
              proof = await requestProofViaSessionPush(opponentAddr, pingRequest);
            }

            distance = proof.distance;
            proofBuf = Buffer.from(proof.proofHex, 'hex');
            publicInputsBufs = proof.publicInputsHex.map(h => Buffer.from(h, 'hex'));
          } catch (relayError) {
            if (isProverSchemaMismatchError(relayError)) {
              throw relayError;
            }
            if (!opponentSecret) {
              throw relayError;
            }

            // Local fallback: generate proof client-side (single-browser testing).
            const result = await provePingNoir({
              sessionId,
              turn: submittedTurn,
              partialDx,
              partialDy,
              responderX: opponentSecret.x,
              responderY: opponentSecret.y,
              responderSalt: opponentSecret.salt,
              responderCommitment: responderCommitmentHex,
            });

            distance = result.distance;
            proofBuf = Buffer.from(result.proofHex, 'hex');
            publicInputsBufs = result.publicInputsHex.map(h => Buffer.from(h, 'hex'));
          } finally {
            setRelayStatusMessage(null);
          }
        } else {
          // Local deterministic fallback: generate proof entirely client-side.
          if (!opponentSecret) {
            throw new Error(
              'Missing local secret data for deterministic fallback. ' +
              'Reload the session or configure VITE_DEAD_DROP_PROVER_URL.'
            );
          }

          const result = await provePingNoir({
            sessionId,
            turn: submittedTurn,
            partialDx,
            partialDy,
            responderX: opponentSecret.x,
            responderY: opponentSecret.y,
            responderSalt: opponentSecret.salt,
            responderCommitment: responderCommitmentHex,
          });

          distance = result.distance;
          proofBuf = Buffer.from(result.proofHex, 'hex');
          publicInputsBufs = result.publicInputsHex.map(h => Buffer.from(h, 'hex'));
        }

        const signer = getContractSigner();
        await deadDropService.submitPing(
          sessionId, userAddress, submittedTurn, distance,
          partialDx, partialDy,
          proofBuf, publicInputsBufs, signer
        );

        const zone = getTemperatureZone(distance);
        sound.playPingResult(zone);
        setPingHistory(prev => {
          // We optimistic update, but filter out duplicates if event comes in later
          if (prev.some(p => p.turn === submittedTurn)) return prev;
          return [...prev, {
            turn: submittedTurn, x: selectedCell.x, y: selectedCell.y, distance, zone, player: userAddress, coordVisibility: 'exact' as const
          }].sort((a, b) => a.turn - b.turn)
        });
        setSelectedCell(null);
        showToast(distance === 0 ? 'DROP FOUND!' : `${zone} (${distance}m)`, 'info', 3000);
        const updatedGame = await deadDropService.getGame(sessionId);
        setGameState(updatedGame);
        const newPhase = derivePhase(updatedGame);
        setGamePhase(newPhase);
        void sendPushDirectBestEffort(opponentAddr, 'game.hint', {
          type: 'ping',
          session_id: sessionId,
          ping: {
            turn: submittedTurn,
            x: partialDx,
            y: partialDy,
            distance,
            player: userAddress,
          },
        });
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
        showToast('Timeout claimed', 'success');
        sound.playTimeout();
        const game = await deadDropService.getGame(sessionId);
        setGameState(game); setGamePhase('game_over'); setShowGameOverModal(true); onStandingsRefresh();
        const currentGame = gameStateRef.current;
        if (currentGame) {
          const opponentAddress = currentGame.player1 === userAddress
            ? currentGame.player2
            : currentGame.player1;
          void sendPushDirectBestEffort(opponentAddress, 'game.hint', {
            type: 'timeout',
            session_id: sessionId,
          });
        }
      } catch (err: any) {
        showToast(err.message || 'Timeout not reached yet', 'error');
      } finally { setLoading(false); }
    });
  };

  const handleStartNewGame = () => {
    if (gameState?.winner) onGameComplete();
    sound.stopAmbient();
    actionLock.current = false;
    relayResponderBusy.current = false;
    missingSessionNotified.current = false;
    webRtcPeerRef.current?.close();
    webRtcPeerRef.current = null;
    sessionPushRef.current?.close();
    sessionPushRef.current = null;
    rejectPendingPushProofRequests('Game reset');
    setIsWebRtcReady(false);
    setRelayStatusMessage(null);
    setGamePhase('create'); setSessionId(createRandomSessionId());
    setGameState(null); setPlayerSecret(null); setPingHistory([]);
    setSelectedCell(null); setLoading(false);
    setCreateMode('create'); setExportedAuthEntryXDR(null);
    setImportAuthEntryXDR(''); setImportPlayer2Points(DEFAULT_POINTS);
    setLoadSessionId(''); setCopied(false);
    setJoinRoomCode('');
    setShowDebug(false); setShowGameOverModal(false);
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    showToast('Copied to clipboard', 'info', 1000);
    setTimeout(() => setCopied(false), 2000);
  };

  // Render
  return (
    <div className="relative h-full flex flex-col overflow-hidden">
      {/* Top HUD - Always visible with mute button */}
      <div className="flex-none flex items-center justify-between px-4 py-3 bg-black/40 border-b border-emerald-500/10 z-10 backdrop-blur-sm">
        <button
          onClick={() => gamePhase !== 'create' && setShowInfoModal(true)}
          className={`p-2 transition-colors ${gamePhase === 'create'
            ? 'text-slate-600 cursor-default'
            : 'text-slate-400 hover:text-emerald-400'
            }`}
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
        {/* CREATE SCREEN - Lobby or Quick Match */}
        {gamePhase === 'create' && (
          <div className="flex-1 flex flex-col items-center justify-center p-6 pb-20 overflow-y-auto">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="w-full max-w-xs space-y-8"
            >
              <div className="text-center space-y-3">
                <div className="relative inline-block">
                  <div className="w-24 h-24 mx-auto border-2 border-emerald-500/30 rounded-full flex items-center justify-center bg-emerald-500/5 shadow-[0_0_30px_rgba(16,185,129,0.1)]">
                    <Target className="w-12 h-12 text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
                  </div>
                  <div className="absolute inset-0 rounded-full border border-emerald-500/20 animate-ping opacity-20" />
                </div>

                <div>
                  <h1 className="text-3xl font-black text-emerald-400 uppercase tracking-[0.2em] drop-shadow-sm">Dead Drop</h1>
                  <p className="text-xs text-slate-500 font-medium tracking-wide mt-1">Find the secret location</p>
                </div>
              </div>

              {/* Tabs for Create Lobby / Join Game */}
              <div className="bg-black/40 rounded-xl p-1.5 border border-white/5 backdrop-blur-sm">
                <div className="flex gap-1">
                  <button
                    onClick={() => setCreateMode('create')}
                    className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-bold tracking-wider uppercase transition-all ${createMode === 'create'
                      ? 'bg-emerald-500/20 text-emerald-400 shadow-sm border border-emerald-500/20'
                      : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
                      }`}
                  >
                    Create
                  </button>
                  <button
                    onClick={() => setCreateMode('join')}
                    className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-bold tracking-wider uppercase transition-all ${createMode === 'join'
                      ? 'bg-emerald-500/20 text-emerald-400 shadow-sm border border-emerald-500/20'
                      : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
                      }`}
                  >
                    Join
                  </button>
                </div>
              </div>

              {/* Create Lobby Tab */}
              <AnimatePresence mode="wait">
                {createMode === 'create' ? (
                  <motion.div
                    key="create"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-4 pt-2"
                  >
                    <ActionButton
                      label="Open Lobby"
                      onClick={handleOpenGame}
                      loading={loading}
                      variant="primary"
                      fullWidth
                      icon={<Target className="w-4 h-4" />}
                    />
                    <p className="text-[10px] text-slate-600 text-center leading-relaxed">
                      Start a new game session and invite a friend using a room code.
                    </p>
                  </motion.div>
                ) : (
                  <motion.div
                    key="join"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-5 pt-2"
                  >
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
                      variant="primary"
                      fullWidth
                      icon={<Target className="w-4 h-4" />}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </div>
        )}

        {/* WAITING FOR OPPONENT - Lobby Created */}
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

        {/* COMMIT PHASE */}
        {gamePhase === 'commit' && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 pb-20">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full max-w-xs text-center flex flex-col items-center gap-10"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-purple-500/20 blur-2xl rounded-full" />
                <div className="relative w-24 h-24 mx-auto border-2 border-purple-500/50 rounded-full flex items-center justify-center bg-black/40 shadow-[0_0_30px_rgba(168,85,247,0.2)]">
                  <Target className="w-10 h-10 text-purple-400 drop-shadow-[0_0_8px_rgba(192,132,252,0.6)]" />
                </div>
              </div>

              <div className="space-y-3">
                <h2 className="text-2xl font-black text-purple-400 uppercase tracking-widest drop-shadow-sm">Set Location</h2>
                <div className="h-px w-16 bg-purple-500/30 mx-auto" />
                <p className="text-xs text-slate-400 max-w-[200px] mx-auto leading-relaxed">
                  Your coordinates will be cryptographically secured.
                </p>
              </div>

              <div className="w-full">
                <div className="p-4 bg-purple-900/10 border border-purple-500/10 rounded-xl mb-6">
                  <p className="text-[10px] text-purple-300/70 uppercase tracking-wider font-medium">
                    Status: <span className="text-purple-400 font-bold ml-1">UNSECURED</span>
                  </p>
                </div>

                <ActionButton
                  label="Lock Coordinates"
                  onClick={handleCommitSecret}
                  loading={loading}
                  variant="primary"
                  icon={<Target className="w-4 h-4" />}
                  fullWidth
                />
              </div>
            </motion.div>
          </div>
        )}

        {/* WAITING COMMIT */}
        {gamePhase === 'waiting_commit' && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 pb-20">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center space-y-6"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-cyan-500/10 blur-xl rounded-full animate-pulse" />
                <Loader2 className="relative w-14 h-14 text-cyan-400 mx-auto animate-spin" />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-bold text-cyan-400 uppercase tracking-widest">Opponent committing...</p>
                <p className="text-[10px] text-slate-500 uppercase tracking-wide">Secure link establishment in progress</p>
              </div>
            </motion.div>
          </div>
        )}

        {/* MAIN GAMEPLAY */}
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
                  dropCoords={getDropCoords() ?? (showDebug ? manualDrop : null)}
                  userAddress={userAddress}
                />
              </div>

              {/* Turn indicator overlay */}
              <AnimatePresence>
                {gamePhase === 'opponent_turn' && (
                  <motion.div
                    initial={{ opacity: 0, backdropFilter: "blur(0px)" }}
                    animate={{ opacity: 1, backdropFilter: "blur(2px)" }}
                    exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
                    className="absolute inset-0 bg-black/40 z-20 flex flex-col items-center justify-center pointer-events-none"
                  >
                    <div className="bg-black/80 border border-slate-700/50 px-6 py-4 rounded-xl flex flex-col items-center gap-3 backdrop-blur-md shadow-2xl">
                      <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
                      <p className="text-xs font-bold text-slate-300 uppercase tracking-widest">
                        {relayStatusMessage || "Opponent's turn"}
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Action bar - Fixed at bottom of game area */}
            <AnimatePresence>
              {gamePhase === 'my_turn' && selectedCell && (
                <motion.div
                  initial={{ y: "100%" }}
                  animate={{ y: 0 }}
                  exit={{ y: "100%" }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
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
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* GAME OVER (map still visible) */}
        {gamePhase === 'game_over' && (
          <div className="flex-1 relative w-full h-full">
            <div className="absolute inset-0 grayscale-[50%]">
              <GameMap
                pingHistory={pingHistory}
                selectedCell={null}
                onCellSelect={() => { }}
                interactive={false}
                showDrop={true}
                dropCoords={getDropCoords() ?? manualDrop}
                userAddress={userAddress}
              />
            </div>
            <div className="absolute inset-0 bg-black/60 pointer-events-none" />
          </div>
        )}
      </div>

      {/* MODALS */}
      <Modal isOpen={showHistoryModal} onClose={() => setShowHistoryModal(false)} title="Mission Log">
        <div className="max-h-[60vh] overflow-y-auto pr-2 -mr-2 spy-scrollbar">
          {pingHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-600 gap-3">
              <History className="w-8 h-8 opacity-50" />
              <p className="text-xs uppercase tracking-widest">No activity recorded</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="px-2">
                <p className="text-[10px] text-amber-300/80 uppercase tracking-wide">
                  Opponent coordinates stay unknown by design. Only temperature and distance are revealed.
                </p>
              </div>
              {[...pingHistory].reverse().map((ping, i) => {
                const isMe = ping.player === userAddress;
                const hasExactCoords = ping.coordVisibility === 'exact';
                return (
                  <div key={i} className={`flex items-center justify-between p-3 border rounded-lg transition-colors ${isMe ? 'bg-emerald-500/5 border-emerald-500/15 hover:bg-emerald-500/10' : 'bg-amber-500/5 border-amber-500/15 hover:bg-amber-500/10'}`}>
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500 uppercase tracking-wide font-bold">Turn {ping.turn}</span>
                        <span className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${isMe ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
                          {isMe ? 'You' : 'Opp'}
                        </span>
                      </div>
                      <span className="font-mono text-xs text-slate-300">
                        {hasExactCoords
                          ? formatLatLng(gridToLatLng(ping.x, ping.y).lat, gridToLatLng(ping.x, ping.y).lng)
                          : 'UNKNOWN (CLASSIFIED)'}
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
          )}
        </div>
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
              onClick={() => { setShowDebug(!showDebug); showToast(showDebug ? 'Debug disabled' : 'Debug enabled', 'info', 1000); }}
              className="w-full py-2 text-xs text-slate-500 hover:text-red-400 transition-colors"
            >
              {showDebug ? 'Disable' : 'Enable'} Debug Mode
            </button>
            {showDebug && (
              <div className="mt-2 p-2 bg-red-900/20 rounded text-xs text-red-400 space-y-2">
                {/* Own coords — copyable */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--color-ink-muted)', fontSize: '0.75rem' }}>Your drop:</span>
                  <code style={{ color: '#f59e0b', fontSize: '0.75rem' }}>
                    {playerSecret ? `${playerSecret.x},${playerSecret.y}` : 'N/A'}
                  </code>
                  {playerSecret && (
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(`${playerSecret.x},${playerSecret.y}`);
                        setCopiedCoords(true);
                        setTimeout(() => setCopiedCoords(false), 2000);
                      }}
                      className="p-0.5 hover:text-amber-400 transition-colors"
                      title="Copy coordinates"
                    >
                      {copiedCoords ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  )}
                </div>

                {/* Manual opponent-coord input */}
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <span style={{ color: 'var(--color-ink-muted)', fontSize: '0.75rem' }}>Opp:</span>
                  <input
                    type="number" min={0} max={99} value={manualOppX}
                    onChange={e => setManualOppX(e.target.value)}
                    placeholder="X"
                    style={{ width: '3rem', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', padding: '2px 4px', color: '#fff', fontSize: '0.75rem' }}
                  />
                  <input
                    type="number" min={0} max={99} value={manualOppY}
                    onChange={e => setManualOppY(e.target.value)}
                    placeholder="Y"
                    style={{ width: '3rem', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', padding: '2px 4px', color: '#fff', fontSize: '0.75rem' }}
                  />
                  {manualOppX !== '' && manualOppY !== '' && playerSecret && (
                    <span style={{ color: '#f59e0b', fontSize: '0.75rem' }}>
                      → {(playerSecret.x + Number(manualOppX)) % GRID_SIZE},{(playerSecret.y + Number(manualOppY)) % GRID_SIZE}
                    </span>
                  )}
                </div>

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

      <ToastSystem toast={toast} onDismiss={handleDismissToast} />
    </div>
  );
}
