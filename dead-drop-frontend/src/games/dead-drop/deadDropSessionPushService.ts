export interface SessionDirectMessage {
  from: string;
  event: string;
  payload: unknown;
}

export interface SessionBroadcastMessage {
  from: string;
  event: string;
  payload: unknown;
}

interface SessionPushOptions {
  proverUrl: string;
  sessionId: number;
  selfAddress: string;
  onDirect?: (message: SessionDirectMessage) => void;
  onBroadcast?: (message: SessionBroadcastMessage) => void;
  onPeerJoined?: (player: string) => void;
  onPeerLeft?: (player: string) => void;
  onReady?: (peers: string[]) => void;
  onError?: (error: Error) => void;
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

export class DeadDropSessionPushClient {
  private readonly options: SessionPushOptions;
  private socket: WebSocket | null = null;
  private closed = false;

  constructor(options: SessionPushOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('Session push client is closed');
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    const wsUrl = toWsUrl(
      this.options.proverUrl,
      this.options.sessionId,
      this.options.selfAddress
    );

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

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
        reject(new Error('Failed to connect session push socket'));
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });

    socket.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener('close', () => {
      if (this.closed) return;
      this.options.onError?.(new Error('Session push socket closed'));
    });
    socket.addEventListener('error', () => {
      if (this.closed) return;
      this.options.onError?.(new Error('Session push socket errored'));
    });
  }

  isOpen(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  sendDirect(to: string, event: string, payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Session push socket is not open');
    }
    this.socket.send(JSON.stringify({
      type: 'app-direct',
      to,
      event,
      payload,
    }));
  }

  sendBroadcast(event: string, payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Session push socket is not open');
    }
    this.socket.send(JSON.stringify({
      type: 'app-broadcast',
      event,
      payload,
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      // no-op
    }
    this.socket = null;
  }

  private handleMessage(raw: unknown): void {
    let message: any;
    try {
      const text = typeof raw === 'string' ? raw : String(raw);
      message = JSON.parse(text);
    } catch {
      return;
    }

    const type = String(message?.type || '');
    if (type === 'webrtc:ready') {
      const peers = Array.isArray(message?.peers)
        ? message.peers.filter((peer: unknown) => typeof peer === 'string')
        : [];
      this.options.onReady?.(peers);
      return;
    }
    if (type === 'webrtc:peer-joined') {
      const player = String(message?.player || '');
      if (player) this.options.onPeerJoined?.(player);
      return;
    }
    if (type === 'webrtc:peer-left') {
      const player = String(message?.player || '');
      if (player) this.options.onPeerLeft?.(player);
      return;
    }
    if (type === 'webrtc:error') {
      const error = String(message?.error || 'session push error');
      this.options.onError?.(new Error(error));
      return;
    }
    if (type === 'app-direct') {
      const from = String(message?.from || '');
      const event = String(message?.event || '');
      if (!from || !event) return;
      this.options.onDirect?.({ from, event, payload: message?.payload });
      return;
    }
    if (type === 'app-broadcast') {
      const from = String(message?.from || '');
      const event = String(message?.event || '');
      if (!from || !event) return;
      this.options.onBroadcast?.({ from, event, payload: message?.payload });
      return;
    }
  }
}
