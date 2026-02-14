import type { RelayProofArtifacts } from './deadDropRelayService';

export interface WebRtcPingRequest {
  sessionId: number;
  turn: number;
  partialDx: number;
  partialDy: number;
}

export interface DeadDropWebRtcOptions {
  proverUrl: string;
  sessionId: number;
  selfAddress: string;
  peerAddress: string;
  requestTimeoutMs?: number;
  iceServers?: RTCIceServer[];
}

type IncomingRequestHandler = (request: WebRtcPingRequest) => Promise<RelayProofArtifacts>;

type SignalMessageType =
  | 'signal-offer'
  | 'signal-answer'
  | 'signal-ice'
  | 'webrtc:ready'
  | 'webrtc:peer-joined'
  | 'webrtc:peer-left'
  | 'webrtc:error';

interface SignalMessage {
  type: SignalMessageType;
  from?: string;
  player?: string;
  peers?: string[];
  payload?: any;
  error?: string;
}

type DataMessage =
  | {
    type: 'ping_request';
    request_id: string;
    session_id: number;
    turn: number;
    partial_dx: number;
    partial_dy: number;
  }
  | {
    type: 'ping_response';
    request_id: string;
    proof: RelayProofArtifacts;
  }
  | {
    type: 'ping_error';
    request_id: string;
    error: string;
  };

interface PendingRequest {
  resolve: (proof: RelayProofArtifacts) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function toWsUrl(baseUrl: string, sessionId: number, player: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  const wsBase = trimmed.startsWith('https://')
    ? trimmed.replace(/^https:\/\//, 'wss://')
    : trimmed.replace(/^http:\/\//, 'ws://');
  const query = new URLSearchParams({
    session_id: String(sessionId),
    player,
  });
  return `${wsBase}/relay/webrtc?${query.toString()}`;
}

function isRelayProofArtifacts(value: unknown): value is RelayProofArtifacts {
  const candidate = value as Partial<RelayProofArtifacts> | null;
  return !!candidate
    && Number.isInteger(candidate.distance)
    && typeof candidate.proofHex === 'string'
    && Array.isArray(candidate.publicInputsHex);
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export class DeadDropWebRtcPeer {
  private readonly options: DeadDropWebRtcOptions;
  private readonly isInitiator: boolean;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private signalSocket: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private requestHandler: IncomingRequestHandler | null = null;
  private connected = false;
  private closed = false;
  private connectingPromise: Promise<void> | null = null;
  private resolveConnected: (() => void) | null = null;
  private rejectConnected: ((error: Error) => void) | null = null;
  private connectedPromise: Promise<void>;
  private makingOffer = false;
  private offerRetryScheduled = false;
  private needOffer = false;

  constructor(options: DeadDropWebRtcOptions) {
    this.options = options;
    this.isInitiator = options.selfAddress < options.peerAddress;
    this.connectedPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnected = resolve;
      this.rejectConnected = reject;
    });
  }

  isReady(): boolean {
    return this.connected && this.dataChannel?.readyState === 'open';
  }

  async connect(requestHandler: IncomingRequestHandler): Promise<void> {
    if (this.closed) {
      throw new Error('WebRTC peer is closed');
    }
    this.requestHandler = requestHandler;
    if (!this.connectingPromise) {
      this.connectingPromise = this.connectInternal();
    }
    await this.connectingPromise;
  }

  async requestProof(request: WebRtcPingRequest): Promise<RelayProofArtifacts> {
    await this.connectedPromise;
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('WebRTC data channel is not open');
    }

    const timeoutMs = this.options.requestTimeoutMs ?? 120_000;
    const requestId = createRequestId();
    const payload: DataMessage = {
      type: 'ping_request',
      request_id: requestId,
      session_id: request.sessionId,
      turn: request.turn,
      partial_dx: request.partialDx,
      partial_dy: request.partialDy,
    };

    return new Promise<RelayProofArtifacts>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Timed out waiting for WebRTC proof response'));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.sendData(payload);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;

    if (this.rejectConnected) {
      this.rejectConnected(new Error('WebRTC peer closed'));
      this.rejectConnected = null;
      this.resolveConnected = null;
    }

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('WebRTC peer closed'));
    }
    this.pendingRequests.clear();

    try {
      this.dataChannel?.close();
    } catch {
      // no-op
    }
    this.dataChannel = null;

    try {
      this.pc?.close();
    } catch {
      // no-op
    }
    this.pc = null;

    try {
      this.signalSocket?.close();
    } catch {
      // no-op
    }
    this.signalSocket = null;
  }

  private async connectInternal(): Promise<void> {
    await this.openSignalSocket();
    this.ensurePeerConnection();

    // If both peers are already connected and this side is deterministic initiator,
    // trigger offer immediately.
    if (this.isInitiator) {
      await this.maybeStartOffer();
    }

    await this.connectedPromise;
  }

  private async openSignalSocket(): Promise<void> {
    if (this.signalSocket && this.signalSocket.readyState === WebSocket.OPEN) {
      return;
    }

    const wsUrl = toWsUrl(this.options.proverUrl, this.options.sessionId, this.options.selfAddress);
    const socket = new WebSocket(wsUrl);
    this.signalSocket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onOpen = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        reject(new Error('Failed to connect WebRTC signaling socket'));
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });

    socket.addEventListener('message', (event) => {
      void this.onSignalMessage(event.data);
    });
    socket.addEventListener('close', () => {
      if (this.closed) return;
      this.failConnected(new Error('WebRTC signaling socket closed'));
    });
    socket.addEventListener('error', () => {
      if (this.closed) return;
      this.failConnected(new Error('WebRTC signaling socket errored'));
    });
  }

  private ensurePeerConnection(): RTCPeerConnection {
    if (this.pc) return this.pc;

    const pc = new RTCPeerConnection({
      iceServers: this.options.iceServers ?? [{ urls: ['stun:stun.l.google.com:19302'] }],
    });
    this.pc = pc;

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.sendSignal('signal-ice', {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment,
      });
    };

    pc.ondatachannel = (event) => {
      this.bindDataChannel(event.channel);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        this.markConnected();
        return;
      }
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.failConnected(new Error(`WebRTC connection state: ${state}`));
      }
    };

    return pc;
  }

  private bindDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    channel.onopen = () => this.markConnected();
    channel.onclose = () => this.failConnected(new Error('WebRTC data channel closed'));
    channel.onerror = () => this.failConnected(new Error('WebRTC data channel errored'));
    channel.onmessage = (event) => {
      void this.onDataMessage(event.data);
    };
  }

  private scheduleOfferRetry(): void {
    if (this.offerRetryScheduled) return;
    this.offerRetryScheduled = true;
    setTimeout(() => {
      this.offerRetryScheduled = false;
      void this.maybeStartOffer();
    }, 150);
  }

  private async maybeStartOffer(): Promise<void> {
    if (!this.isInitiator || this.closed) return;
    const pc = this.ensurePeerConnection();
    if (this.makingOffer) {
      this.needOffer = true;
      return;
    }
    if (pc.signalingState !== 'stable') {
      this.needOffer = true;
      this.scheduleOfferRetry();
      return;
    }

    this.makingOffer = true;
    this.needOffer = false;
    if (!this.dataChannel) {
      const channel = pc.createDataChannel('dead-drop-proof');
      this.bindDataChannel(channel);
    }
    try {
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') {
        this.needOffer = true;
        this.scheduleOfferRetry();
        return;
      }
      await pc.setLocalDescription(offer);
      this.sendSignal('signal-offer', {
        type: offer.type,
        sdp: offer.sdp,
      });
    } catch (error) {
      this.needOffer = true;
      this.scheduleOfferRetry();
      console.warn('WebRTC offer negotiation retry:', error);
    } finally {
      this.makingOffer = false;
      if (this.needOffer && pc.signalingState === 'stable') {
        this.scheduleOfferRetry();
      }
    }
  }

  private sendSignal(type: 'signal-offer' | 'signal-answer' | 'signal-ice', payload: any): void {
    if (!this.signalSocket || this.signalSocket.readyState !== WebSocket.OPEN) return;
    this.signalSocket.send(JSON.stringify({
      type,
      to: this.options.peerAddress,
      payload,
    }));
  }

  private sendData(message: DataMessage): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('WebRTC data channel is not open');
    }
    this.dataChannel.send(JSON.stringify(message));
  }

  private async onSignalMessage(raw: unknown): Promise<void> {
    let message: SignalMessage;
    try {
      const text = typeof raw === 'string' ? raw : String(raw);
      message = JSON.parse(text) as SignalMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case 'webrtc:ready':
        if (this.isInitiator && (message.peers || []).includes(this.options.peerAddress)) {
          await this.maybeStartOffer();
        }
        return;
      case 'webrtc:peer-joined':
        if (this.isInitiator && message.player === this.options.peerAddress) {
          await this.maybeStartOffer();
        }
        return;
      case 'webrtc:peer-left':
        if (message.player === this.options.peerAddress) {
          this.failConnected(new Error('Peer disconnected from signaling'));
        }
        return;
      case 'webrtc:error':
        // Signal-server-side delivery errors should not crash the app;
        // keep trying while peer joins.
        console.warn('WebRTC signaling warning:', message.error || 'unknown');
        return;
      case 'signal-offer':
        await this.onSignalOffer(message);
        return;
      case 'signal-answer':
        await this.onSignalAnswer(message);
        return;
      case 'signal-ice':
        await this.onSignalIce(message);
        return;
      default:
        return;
    }
  }

  private async onSignalOffer(message: SignalMessage): Promise<void> {
    if (message.from !== this.options.peerAddress) return;
    const payload = message.payload || {};
    if (payload.type !== 'offer' || typeof payload.sdp !== 'string') return;

    const pc = this.ensurePeerConnection();
    const offerDescription = {
      type: 'offer' as const,
      sdp: payload.sdp,
    };
    const offerCollision = this.makingOffer || pc.signalingState !== 'stable';
    if (offerCollision) {
      try {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription(offerDescription),
        ]);
      } catch {
        // If rollback is not available, ignore this overlapping offer.
        return;
      }
    } else {
      await pc.setRemoteDescription(offerDescription);
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.sendSignal('signal-answer', {
      type: answer.type,
      sdp: answer.sdp,
    });
  }

  private async onSignalAnswer(message: SignalMessage): Promise<void> {
    if (message.from !== this.options.peerAddress) return;
    const payload = message.payload || {};
    if (payload.type !== 'answer' || typeof payload.sdp !== 'string') return;
    if (!this.pc) return;
    await this.pc.setRemoteDescription({
      type: 'answer',
      sdp: payload.sdp,
    });
  }

  private async onSignalIce(message: SignalMessage): Promise<void> {
    if (message.from !== this.options.peerAddress) return;
    const payload = message.payload || {};
    if (!this.pc || typeof payload.candidate !== 'string') return;
    await this.pc.addIceCandidate(new RTCIceCandidate({
      candidate: payload.candidate,
      sdpMid: payload.sdpMid ?? null,
      sdpMLineIndex: Number.isInteger(payload.sdpMLineIndex) ? payload.sdpMLineIndex : null,
      usernameFragment: payload.usernameFragment ?? null,
    }));
  }

  private async onDataMessage(raw: unknown): Promise<void> {
    let message: DataMessage;
    try {
      const text = typeof raw === 'string' ? raw : String(raw);
      message = JSON.parse(text) as DataMessage;
    } catch {
      return;
    }

    if (message.type === 'ping_response') {
      const pending = this.pendingRequests.get(message.request_id);
      if (!pending) return;
      this.pendingRequests.delete(message.request_id);
      clearTimeout(pending.timer);
      if (!isRelayProofArtifacts(message.proof)) {
        pending.reject(new Error('Invalid proof payload from peer'));
        return;
      }
      pending.resolve(message.proof);
      return;
    }

    if (message.type === 'ping_error') {
      const pending = this.pendingRequests.get(message.request_id);
      if (!pending) return;
      this.pendingRequests.delete(message.request_id);
      clearTimeout(pending.timer);
      pending.reject(new Error(message.error || 'Peer failed to produce proof'));
      return;
    }

    if (message.type !== 'ping_request') return;

    const handler = this.requestHandler;
    if (!handler) return;
    if (
      !Number.isInteger(message.session_id)
      || !Number.isInteger(message.turn)
      || !Number.isInteger(message.partial_dx)
      || !Number.isInteger(message.partial_dy)
    ) {
      return;
    }

    try {
      const proof = await handler({
        sessionId: message.session_id,
        turn: message.turn,
        partialDx: message.partial_dx,
        partialDy: message.partial_dy,
      });
      this.sendData({
        type: 'ping_response',
        request_id: message.request_id,
        proof,
      });
    } catch (err) {
      this.sendData({
        type: 'ping_error',
        request_id: message.request_id,
        error: err instanceof Error ? err.message : 'Failed to generate proof',
      });
    }
  }

  private markConnected(): void {
    if (this.connected) return;
    this.connected = true;
    if (this.resolveConnected) {
      this.resolveConnected();
      this.resolveConnected = null;
      this.rejectConnected = null;
    }
  }

  private failConnected(error: Error): void {
    if (this.closed) return;
    if (this.rejectConnected) {
      this.rejectConnected(error);
      this.rejectConnected = null;
      this.resolveConnected = null;
    }
  }
}
