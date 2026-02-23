import { create } from 'zustand';

export type WalletOperation =
  | 'idle'
  | 'connect-wallet'
  | 'switch-dev';

export type WalletStage =
  | 'idle'
  | 'validating'
  | 'opening_wallet'
  | 'finalizing'
  | 'done'
  | 'error';

export interface WalletState {
  // Wallet connection
  publicKey: string | null;
  walletId: string | null; // ID of the connected wallet
  walletType: 'dev' | 'wallet' | null;
  isConnected: boolean;
  isConnecting: boolean;

  // Network info
  network: string | null;
  networkPassphrase: string | null;

  // Error handling
  error: string | null;
  walletOperation: WalletOperation;
  walletStage: WalletStage;
  walletStageMessage: string | null;

  // Actions
  setWallet: (publicKey: string, walletId: string, walletType: 'dev' | 'wallet') => void;
  setPublicKey: (publicKey: string) => void;
  setConnected: (connected: boolean) => void;
  setConnecting: (connecting: boolean) => void;
  setNetwork: (network: string, networkPassphrase: string) => void;
  setError: (error: string | null) => void;
  startWalletOperation: (operation: WalletOperation, stage: WalletStage, message?: string | null) => void;
  setWalletStage: (stage: WalletStage, message?: string | null) => void;
  completeWalletOperation: (message?: string | null) => void;
  failWalletOperation: (errorMessage: string) => void;
  disconnect: () => void;
  reset: () => void;
}

const initialState = {
  publicKey: null,
  walletId: null,
  walletType: null,
  isConnected: false,
  isConnecting: false,
  network: null,
  networkPassphrase: null,
  error: null,
  walletOperation: 'idle' as WalletOperation,
  walletStage: 'idle' as WalletStage,
  walletStageMessage: null,
};

export const useWalletStore = create<WalletState>()((set) => ({
  ...initialState,

  setWallet: (publicKey, walletId, walletType) =>
    set({
      publicKey,
      walletId,
      walletType,
      isConnected: true,
      isConnecting: false,
      error: null,
      walletOperation: 'idle',
      walletStage: 'done',
      walletStageMessage: 'Connected',
    }),

  setPublicKey: (publicKey) =>
    set({
      publicKey,
      isConnected: true,
      isConnecting: false,
      error: null,
      walletOperation: 'idle',
      walletStage: 'done',
      walletStageMessage: 'Connected',
    }),

  setConnected: (connected) =>
    set({
      isConnected: connected,
      isConnecting: false,
      walletOperation: connected ? 'idle' : 'idle',
      walletStage: connected ? 'done' : 'idle',
      walletStageMessage: connected ? 'Connected' : null,
    }),

  setConnecting: (connecting) =>
    set((state) => ({
      isConnecting: connecting,
      // Clear stale errors when a new connection attempt starts,
      // but preserve a freshly-set error after a failed attempt.
      error: connecting ? null : state.error,
      walletStage: connecting ? (state.walletStage === 'idle' ? 'validating' : state.walletStage) : state.walletStage,
    })),

  setNetwork: (network, networkPassphrase) =>
    set({
      network,
      networkPassphrase,
    }),

  setError: (error) =>
    set({
      error,
      isConnecting: false,
      walletStage: error ? 'error' : 'idle',
      walletStageMessage: error,
    }),

  startWalletOperation: (operation, stage, message = null) =>
    set({
      walletOperation: operation,
      walletStage: stage,
      walletStageMessage: message,
      isConnecting: true,
      error: null,
    }),

  setWalletStage: (stage, message = null) =>
    set((state) => ({
      walletStage: stage,
      walletStageMessage: message,
      isConnecting: stage !== 'done' && stage !== 'error' ? true : state.isConnecting,
    })),

  completeWalletOperation: (message = null) =>
    set({
      walletOperation: 'idle',
      walletStage: 'done',
      walletStageMessage: message,
      isConnecting: false,
      error: null,
    }),

  failWalletOperation: (errorMessage) =>
    set((state) => ({
      walletStage: state.walletStage === 'idle' ? 'error' : state.walletStage,
      walletStageMessage: errorMessage,
      isConnecting: false,
      error: errorMessage,
    })),

  disconnect: () =>
    set({
      ...initialState,
    }),

  reset: () => set(initialState),
}));
