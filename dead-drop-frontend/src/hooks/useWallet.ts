import { useCallback, useEffect } from 'react';
import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit/sdk';
import { defaultModules } from '@creit-tech/stellar-wallets-kit/modules/utils';
import { KitEventType, Networks } from '@creit-tech/stellar-wallets-kit/types';
import { useWalletStore } from '../store/walletSlice';
import { devWalletService, DevWalletService } from '../services/devWalletService';
import { NETWORK, NETWORK_PASSPHRASE, WALLET_MODE } from '../utils/constants';
import type { ContractSigner } from '../types/signer';
import type { WalletError } from '@stellar/stellar-sdk/contract';

const WALLET_ID = 'stellar-wallets-kit';
let walletKitInitialized = false;

type WalletMode = 'dev' | 'wallet' | 'hybrid';

function toWalletError(error?: { message: string; code: number }): WalletError | undefined {
  if (!error) return undefined;
  return { message: error.message, code: error.code };
}

function resolveNetwork(passphrase?: string): Networks {
  if (passphrase && Object.values(Networks).includes(passphrase as Networks)) {
    return passphrase as Networks;
  }
  return NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

function ensureWalletKitInitialized(passphrase?: string) {
  if (typeof window === 'undefined') return;

  if (!walletKitInitialized) {
    StellarWalletsKit.init({
      modules: defaultModules(),
      network: resolveNetwork(passphrase),
    });
    walletKitInitialized = true;
    return;
  }

  if (passphrase) {
    StellarWalletsKit.setNetwork(resolveNetwork(passphrase));
  }
}

function resolveWalletMode(mode: string): WalletMode {
  if (mode === 'wallet' || mode === 'hybrid' || mode === 'dev') return mode;
  if (mode === 'smart-account') {
    console.warn('[useWallet] walletMode "smart-account" is not supported in this build. Falling back to "wallet".');
    return 'wallet';
  }
  return 'dev';
}

export function useWallet() {
  const {
    publicKey,
    walletId,
    walletType,
    isConnected,
    isConnecting,
    network,
    networkPassphrase,
    error,
    walletOperation,
    walletStage,
    walletStageMessage,
    setWallet,
    setNetwork,
    startWalletOperation,
    setWalletStage,
    completeWalletOperation,
    failWalletOperation,
    disconnect: storeDisconnect,
  } = useWalletStore();

  const walletMode = resolveWalletMode(WALLET_MODE);
  const supportsDev = walletMode === 'dev' || walletMode === 'hybrid';
  const supportsWalletKit = walletMode === 'wallet' || walletMode === 'hybrid';

  const connectDev = useCallback(async (playerNumber: 1 | 2) => {
    if (!supportsDev) {
      throw new Error(`Dev wallet is disabled for wallet mode "${walletMode}".`);
    }

    try {
      startWalletOperation('switch-dev', 'validating', `Preparing Player ${playerNumber} wallet...`);
      await devWalletService.initPlayer(playerNumber);
      setWalletStage('finalizing', `Finalizing Player ${playerNumber} wallet session...`);
      setWallet(devWalletService.getPublicKey(), `dev-player${playerNumber}`, 'dev');
      setNetwork(NETWORK, NETWORK_PASSPHRASE);
      completeWalletOperation(`Player ${playerNumber} wallet ready.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect dev wallet';
      failWalletOperation(message);
      throw err;
    }
  }, [supportsDev, walletMode, startWalletOperation, setWalletStage, setWallet, setNetwork, completeWalletOperation, failWalletOperation]);

  const switchPlayer = useCallback(async (playerNumber: 1 | 2) => {
    await connectDev(playerNumber);
  }, [connectDev]);

  const connectWallet = useCallback(async () => {
    if (!supportsWalletKit) {
      throw new Error(`WalletKit is disabled for wallet mode "${walletMode}".`);
    }
    if (typeof window === 'undefined') {
      throw new Error('Wallet connection is only available in the browser.');
    }

    try {
      startWalletOperation('connect-wallet', 'validating', 'Preparing wallet connection...');
      ensureWalletKitInitialized(NETWORK_PASSPHRASE);
      setWalletStage('opening_wallet', 'Waiting for wallet approval...');
      const { address } = await StellarWalletsKit.authModal();
      if (typeof address !== 'string' || !address) {
        throw new Error('No wallet address returned');
      }
      setWalletStage('finalizing', 'Finalizing wallet session...');
      setWallet(address, WALLET_ID, 'wallet');
      setNetwork(NETWORK, NETWORK_PASSPHRASE);
      completeWalletOperation('Wallet connected.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect wallet';
      failWalletOperation(message);
      throw err;
    }
  }, [supportsWalletKit, walletMode, startWalletOperation, setWalletStage, setWallet, setNetwork, completeWalletOperation, failWalletOperation]);

  const connect = useCallback(async () => {
    if (walletMode === 'dev') {
      await connectDev(1);
      return;
    }
    if (walletMode === 'wallet') {
      await connectWallet();
      return;
    }
    // hybrid: prefer existing dev flow for fast testing; wallet button can still call connectWallet directly.
    await connectDev(1);
  }, [walletMode, connectDev, connectWallet]);

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (!supportsWalletKit) return;
    try {
      ensureWalletKitInitialized(NETWORK_PASSPHRASE);
      const address = await StellarWalletsKit.getAddress();
      if (typeof address === 'string' && address) {
        setWallet(address, WALLET_ID, 'wallet');
        setNetwork(NETWORK, NETWORK_PASSPHRASE);
      }
    } catch {
      // ignore refresh failures
    }
  }, [supportsWalletKit, setWallet, setNetwork]);

  const disconnect = useCallback(async () => {
    if (walletType === 'dev') {
      devWalletService.disconnect();
    }
    storeDisconnect();
  }, [walletType, storeDisconnect]);

  const getContractSigner = useCallback((_options?: unknown): ContractSigner => {
    if (!isConnected || !publicKey) {
      throw new Error('Wallet not connected');
    }

    if (walletType === 'dev') {
      return devWalletService.getSigner();
    }

    if (walletType !== 'wallet') {
      throw new Error(`Unsupported wallet type: ${String(walletType)}`);
    }

    return {
      signTransaction: async (xdr, opts) => {
        try {
          ensureWalletKitInitialized(networkPassphrase || NETWORK_PASSPHRASE);
          const result = await StellarWalletsKit.signTransaction(xdr, {
            networkPassphrase: opts?.networkPassphrase || networkPassphrase || NETWORK_PASSPHRASE,
            address: opts?.address || publicKey,
            submit: opts?.submit,
            submitUrl: opts?.submitUrl,
          });

          return {
            signedTxXdr: result.signedTxXdr || xdr,
            signerAddress: result.signerAddress || publicKey,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to sign transaction';
          return {
            signedTxXdr: xdr,
            signerAddress: publicKey,
            error: toWalletError({ message, code: -1 }),
          };
        }
      },
      signAuthEntry: async (authEntry, opts) => {
        try {
          ensureWalletKitInitialized(networkPassphrase || NETWORK_PASSPHRASE);
          const result = await StellarWalletsKit.signAuthEntry(authEntry, {
            networkPassphrase: opts?.networkPassphrase || networkPassphrase || NETWORK_PASSPHRASE,
            address: opts?.address || publicKey,
          });
          return {
            signedAuthEntry: result.signedAuthEntry || authEntry,
            signerAddress: result.signerAddress || publicKey,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to sign auth entry';
          return {
            signedAuthEntry: authEntry,
            signerAddress: publicKey,
            error: toWalletError({ message, code: -1 }),
          };
        }
      },
    };
  }, [isConnected, publicKey, walletType, networkPassphrase]);

  const isDevModeAvailable = useCallback(() => supportsDev && DevWalletService.isDevModeAvailable(), [supportsDev]);
  const isDevPlayerAvailable = useCallback((playerNumber: 1 | 2) => supportsDev && DevWalletService.isPlayerAvailable(playerNumber), [supportsDev]);
  const getCurrentDevPlayer = useCallback(() => (walletType === 'dev' ? devWalletService.getCurrentPlayer() : null), [walletType]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    setNetwork(NETWORK, NETWORK_PASSPHRASE);
    const unsubscribers: Array<() => void> = [];

    if (supportsWalletKit) {
      ensureWalletKitInitialized(NETWORK_PASSPHRASE);

      const unsubscribeState = StellarWalletsKit.on(KitEventType.STATE_UPDATED, (event) => {
        const address = event.payload.address;
        if (typeof address === 'string' && address) {
          setWallet(address, WALLET_ID, 'wallet');
        } else if (walletType === 'wallet') {
          storeDisconnect();
        }
        setNetwork(NETWORK, event.payload.networkPassphrase || NETWORK_PASSPHRASE);
      });

      const unsubscribeDisconnect = StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
        if (walletType === 'wallet') {
          storeDisconnect();
        }
      });

      unsubscribers.push(unsubscribeState, unsubscribeDisconnect);

      void (async () => {
        try {
          const address = await StellarWalletsKit.getAddress();
          if (typeof address === 'string' && address && (walletMode === 'wallet' || !isConnected)) {
            setWallet(address, WALLET_ID, 'wallet');
          }
        } catch {
          // noop
        }
      })();
    }

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [supportsWalletKit, walletMode, isConnected, walletType, setWallet, setNetwork, storeDisconnect]);

  return {
    publicKey,
    walletId,
    walletType,
    isConnected,
    isConnecting,
    network,
    networkPassphrase,
    error,
    walletOperation,
    walletStage,
    walletStageMessage,
    walletMode,
    isWalletAvailable: typeof window !== 'undefined',

    connect,
    connectWallet,
    refresh,
    connectDev,
    switchPlayer,
    disconnect,
    getContractSigner,
    isDevModeAvailable,
    isDevPlayerAvailable,
    getCurrentDevPlayer,
  };
}
