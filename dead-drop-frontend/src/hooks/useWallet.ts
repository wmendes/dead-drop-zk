import { useCallback, useEffect } from 'react';
import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit/sdk';
import { defaultModules } from '@creit-tech/stellar-wallets-kit/modules/utils';
import { KitEventType, Networks } from '@creit-tech/stellar-wallets-kit/types';
import { SmartAccountKit, IndexedDBStorage } from 'smart-account-kit';
import { xdr } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { useWalletStore } from '../store/walletSlice';
import { devWalletService, DevWalletService } from '../services/devWalletService';
import {
  clearDeadDropSessionSignerState,
  executeDeadDropWithSessionSigner,
  scheduleDeadDropSessionSignerCleanup,
} from '../services/deadDropSessionSignerService';
import {
  NETWORK,
  NETWORK_PASSPHRASE,
  RPC_URL,
  WALLET_MODE,
  SMART_ACCOUNT_WASM_HASH,
  SMART_ACCOUNT_WEBAUTHN_VERIFIER_ADDRESS,
  SMART_ACCOUNT_RP_NAME,
  DEV_PLAYER1_SECRET,
} from '../utils/constants';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import type { ContractSigner } from '../types/signer';
import type { WalletError } from '@stellar/stellar-sdk/contract';

const WALLET_ID = 'stellar-wallets-kit';
const SMART_ACCOUNT_ID = 'smart-account-kit';
let walletKitInitialized = false;
let smartAccountKitInstance: SmartAccountKit | null = null;
let smartCredentialId: string | null = null;
let smartAccountCodeStatus: 'unknown' | 'available' | 'missing' = 'unknown';

type WalletMode = 'dev' | 'wallet' | 'smart-account' | 'hybrid';
const DEAD_DROP_SESSION_TTL_MINUTES = 60;

interface ContractSignerOptions {
  preferSessionSigner?: boolean;
  sessionContractId?: string;
  sessionTtlMinutes?: number;
  sessionPhase?: 'setup' | 'gameplay';
  sessionId?: number;
}

function isMissingSmartAccountContractMessage(message: string): boolean {
  return (
    message.includes('contract not found on-chain') ||
    message.includes('The wallet may not have been deployed yet') ||
    message.includes('getLedgerEntries') ||
    message.includes('"entries":[]') ||
    message.includes('entries')
  );
}

function resolveWalletMode(mode: string): WalletMode {
  if (mode === 'wallet' || mode === 'smart-account' || mode === 'hybrid') {
    return mode;
  }
  return 'dev';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSmartAccountWasmIsDeployed(): Promise<void> {
  if (smartAccountCodeStatus === 'available') return;
  if (smartAccountCodeStatus === 'missing') {
    throw new Error(
      `Configured VITE_SMART_ACCOUNT_WASM_HASH (${SMART_ACCOUNT_WASM_HASH}) is not deployed on the selected network.`
    );
  }

  const wasmHash = SMART_ACCOUNT_WASM_HASH.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(wasmHash)) {
    throw new Error('VITE_SMART_ACCOUNT_WASM_HASH must be a 32-byte hex string.');
  }

  const ledgerKey = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({
      hash: Buffer.from(wasmHash, 'hex'),
    })
  ).toXDR('base64');

  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLedgerEntries',
      params: { keys: [ledgerKey] },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to verify smart-account WASM hash (RPC ${response.status}).`);
  }

  const data = (await response.json()) as {
    error?: { message?: string };
    result?: { entries?: unknown[] };
  };

  if (data.error) {
    throw new Error(data.error.message || 'RPC error while checking smart-account WASM hash.');
  }

  const entries = data.result?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    smartAccountCodeStatus = 'missing';
    throw new Error(
      `Configured VITE_SMART_ACCOUNT_WASM_HASH (${SMART_ACCOUNT_WASM_HASH}) is not deployed on the selected network.`
    );
  }

  smartAccountCodeStatus = 'available';
}

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

function smartAccountConfigured(): boolean {
  return Boolean(SMART_ACCOUNT_WASM_HASH && SMART_ACCOUNT_WEBAUTHN_VERIFIER_ADDRESS);
}

function getSmartAccountKit(): SmartAccountKit {
  if (!smartAccountConfigured()) {
    throw new Error(
      'Smart account is not configured. Set VITE_SMART_ACCOUNT_WASM_HASH and VITE_SMART_ACCOUNT_WEBAUTHN_VERIFIER_ADDRESS.'
    );
  }

  if (!smartAccountKitInstance) {
    smartAccountKitInstance = new SmartAccountKit({
      rpcUrl: RPC_URL,
      networkPassphrase: NETWORK_PASSPHRASE,
      accountWasmHash: SMART_ACCOUNT_WASM_HASH,
      webauthnVerifierAddress: SMART_ACCOUNT_WEBAUTHN_VERIFIER_ADDRESS,
      rpName: SMART_ACCOUNT_RP_NAME,
      storage: new IndexedDBStorage(),
    });
  }

  return smartAccountKitInstance;
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
  const supportsSmartAccount = walletMode === 'smart-account' || walletMode === 'hybrid';

  const connectDev = useCallback(
    async (playerNumber: 1 | 2) => {
      if (!supportsDev) {
        throw new Error(`Dev wallet is disabled for wallet mode "${walletMode}".`);
      }

      try {
        startWalletOperation('switch-dev', 'validating', `Preparing Player ${playerNumber} wallet...`);

        await devWalletService.initPlayer(playerNumber);
        setWalletStage('finalizing', `Finalizing Player ${playerNumber} wallet session...`);
        const address = devWalletService.getPublicKey();
        setWallet(address, `dev-player${playerNumber}`, 'dev');
        setNetwork(NETWORK, NETWORK_PASSPHRASE);
        completeWalletOperation(`Player ${playerNumber} wallet ready.`);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to connect dev wallet';
        failWalletOperation(errorMessage);
        throw err;
      }
    },
    [
      supportsDev,
      walletMode,
      setWallet,
      setNetwork,
      startWalletOperation,
      setWalletStage,
      completeWalletOperation,
      failWalletOperation,
    ]
  );

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
  }, [
    supportsWalletKit,
    walletMode,
    setWallet,
    setNetwork,
    startWalletOperation,
    setWalletStage,
    completeWalletOperation,
    failWalletOperation,
  ]);

  const connectSmartAccount = useCallback(async () => {
    if (!supportsSmartAccount) {
      throw new Error(`Smart account is disabled for wallet mode "${walletMode}".`);
    }

    if (typeof window === 'undefined') {
      throw new Error('Smart account connection is only available in the browser.');
    }

    try {
      startWalletOperation('connect-passkey', 'validating', 'Checking passkey wallet configuration...');
      await ensureSmartAccountWasmIsDeployed();
      const kit = getSmartAccountKit();
      setWalletStage('opening_passkey_prompt', 'Approve passkey authentication to continue...');
      const result = await kit.connectWallet({ prompt: true });
      if (!result) {
        throw new Error('No smart account found. Create one with "Create Passkey Wallet".');
      }

      smartCredentialId = result.credentialId;
      clearDeadDropSessionSignerState(kit);
      setWalletStage('finalizing', 'Finalizing passkey wallet session...');
      setWallet(result.contractId, SMART_ACCOUNT_ID, 'smart-account');
      setNetwork(NETWORK, NETWORK_PASSPHRASE);
      completeWalletOperation('Passkey wallet connected.');
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : 'Failed to connect smart account';
      const message =
        isMissingSmartAccountContractMessage(rawMessage)
          ? 'No deployed smart account found for this passkey. Create a passkey wallet first.'
          : rawMessage;
      failWalletOperation(message);
      throw err;
    }
  }, [
    supportsSmartAccount,
    walletMode,
    setWallet,
    setNetwork,
    startWalletOperation,
    setWalletStage,
    completeWalletOperation,
    failWalletOperation,
  ]);

  const createSmartAccount = useCallback(
    async (userName: string) => {
      if (!supportsSmartAccount) {
        throw new Error(`Smart account is disabled for wallet mode "${walletMode}".`);
      }

      if (!userName.trim()) {
        throw new Error('User name is required to create a smart account.');
      }

      try {
        startWalletOperation('create-passkey', 'validating', 'Checking passkey wallet configuration...');
        await ensureSmartAccountWasmIsDeployed();
        const kit = getSmartAccountKit();
        setWalletStage('opening_passkey_prompt', 'Approve passkey registration to create your wallet...');
        setWalletStage('creating_passkey', 'Creating passkey credentials...');
        const result = await kit.createWallet(SMART_ACCOUNT_RP_NAME, userName, {
          autoSubmit: true,
        });

        setWalletStage('deploying_account', 'Deploying smart account on-chain...');
        if (result.submitResult && !result.submitResult.success) {
          throw new Error(
            `Smart account deployment failed: ${result.submitResult.error || 'unknown error'}`
          );
        }

        // Re-connect through SDK to ensure contract exists and session is valid.
        // Retry briefly because RPC visibility can lag right after submission.
        let connected = false;
        let lastConnectError: unknown;
        setWalletStage('finalizing', 'Verifying deployed wallet and finalizing session...');
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await kit.connectWallet({
              credentialId: result.credentialId,
              contractId: result.contractId,
            });
            connected = true;
            break;
          } catch (connectErr) {
            lastConnectError = connectErr;
            await delay(800);
          }
        }

        if (!connected) {
          throw (
            lastConnectError ??
            new Error('Smart account deployment submitted but contract was not visible on-chain.')
          );
        }

        smartCredentialId = result.credentialId;
        clearDeadDropSessionSignerState(kit);
        setWallet(result.contractId, SMART_ACCOUNT_ID, 'smart-account');
        setNetwork(NETWORK, NETWORK_PASSPHRASE);
        completeWalletOperation('Passkey wallet created and connected.');
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : 'Failed to create smart account';
        const message = isMissingSmartAccountContractMessage(rawMessage)
          ? 'Passkey created, but no deployed smart account was found on-chain yet. Check relayer submission and try again.'
          : rawMessage;
        failWalletOperation(message);
        throw err;
      }
    },
    [
      supportsSmartAccount,
      walletMode,
      setWallet,
      setNetwork,
      startWalletOperation,
      setWalletStage,
      completeWalletOperation,
      failWalletOperation,
    ]
  );

  const switchPlayer = useCallback(
    async (playerNumber: 1 | 2) => {
      if (walletType !== 'dev') {
        throw new Error('Can only switch players in dev mode');
      }

      try {
        startWalletOperation('switch-dev', 'validating', `Switching to Player ${playerNumber}...`);
        await devWalletService.switchPlayer(playerNumber);
        setWalletStage('finalizing', `Finalizing Player ${playerNumber} session...`);
        const address = devWalletService.getPublicKey();
        setWallet(address, `dev-player${playerNumber}`, 'dev');
        completeWalletOperation(`Switched to Player ${playerNumber}.`);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to switch player';
        failWalletOperation(errorMessage);
        throw err;
      }
    },
    [walletType, setWallet, startWalletOperation, setWalletStage, completeWalletOperation, failWalletOperation]
  );

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined') return;

    if (supportsSmartAccount) {
      try {
        const kit = getSmartAccountKit();
        const smartSession = await kit.connectWallet();
        if (smartSession) {
          smartCredentialId = smartSession.credentialId;
          clearDeadDropSessionSignerState(kit);
          setWallet(smartSession.contractId, SMART_ACCOUNT_ID, 'smart-account');
          setNetwork(NETWORK, NETWORK_PASSPHRASE);
          return;
        }
      } catch {
        // noop
      }
    }

    if (supportsWalletKit) {
      try {
        ensureWalletKitInitialized(NETWORK_PASSPHRASE);
        const address = await StellarWalletsKit.getAddress();
        if (typeof address === 'string' && address) {
          setWallet(address, WALLET_ID, 'wallet');
          setNetwork(NETWORK, NETWORK_PASSPHRASE);
        }
      } catch {
        // noop
      }
    }
  }, [supportsSmartAccount, supportsWalletKit, setWallet, setNetwork]);

  const connect = useCallback(async () => {
    if (walletMode === 'dev') {
      await connectDev(1);
      return;
    }

    if (walletMode === 'wallet') {
      await connectWallet();
      return;
    }

    if (walletMode === 'smart-account') {
      await connectSmartAccount();
      return;
    }

    try {
      await connectSmartAccount();
    } catch {
      await connectWallet();
    }
  }, [walletMode, connectDev, connectWallet, connectSmartAccount]);

  const disconnect = useCallback(async () => {
    if (walletType === 'dev') {
      devWalletService.disconnect();
    }

    if (walletType === 'smart-account') {
      try {
        const kit = getSmartAccountKit();
        clearDeadDropSessionSignerState(kit);
        await kit.disconnect();
      } catch {
        // noop
      }
      smartCredentialId = null;
    }

    if (walletType !== 'smart-account') {
      clearDeadDropSessionSignerState();
    }

    storeDisconnect();
  }, [walletType, storeDisconnect]);

  const releaseDeadDropSessionSigner = useCallback(() => {
    if (walletType !== 'smart-account') {
      clearDeadDropSessionSignerState();
      return;
    }

    try {
      const kit = getSmartAccountKit();
      scheduleDeadDropSessionSignerCleanup(kit);
    } catch {
      clearDeadDropSessionSignerState();
    }
  }, [walletType]);

  const getContractSigner = useCallback((options?: ContractSignerOptions): ContractSigner => {
    if (!isConnected || !publicKey || !walletType) {
      throw new Error('Wallet not connected');
    }

    if (walletType === 'dev') {
      return devWalletService.getSigner();
    }

    if (walletType === 'wallet') {
      return {
        signTransaction: async (
          txXdr: string,
          opts?: { networkPassphrase?: string; address?: string; submit?: boolean; submitUrl?: string }
        ) => {
          try {
            ensureWalletKitInitialized(networkPassphrase || NETWORK_PASSPHRASE);
            const result = await StellarWalletsKit.signTransaction(txXdr, {
              networkPassphrase: opts?.networkPassphrase || networkPassphrase || NETWORK_PASSPHRASE,
              address: opts?.address || publicKey,
              submit: opts?.submit,
              submitUrl: opts?.submitUrl,
            });

            return {
              signedTxXdr: result.signedTxXdr || txXdr,
              signerAddress: result.signerAddress || publicKey,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to sign transaction';
            return {
              signedTxXdr: txXdr,
              signerAddress: publicKey,
              error: toWalletError({ message, code: -1 }),
            };
          }
        },
        signAuthEntry: async (authEntry: string, opts?: { networkPassphrase?: string; address?: string }) => {
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
    }

    const smartAccountSigner: ContractSigner = {
      signTransaction: async (
        txXdr: string,
        opts?: { networkPassphrase?: string }
      ) => {
        try {
          if (!DEV_PLAYER1_SECRET) {
            throw new Error('VITE_DEV_PLAYER1_SECRET is required as fee payer for smart-account mode.');
          }

          const feePayer = Keypair.fromSecret(DEV_PLAYER1_SECRET);
          const parsed = TransactionBuilder.fromXDR(
            txXdr,
            opts?.networkPassphrase || networkPassphrase || NETWORK_PASSPHRASE
          );
          parsed.sign(feePayer);

          return {
            signedTxXdr: parsed.toXDR(),
            signerAddress: feePayer.publicKey(),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to sign transaction with fee payer';
          return {
            signedTxXdr: txXdr,
            signerAddress: publicKey,
            error: toWalletError({ message, code: -1 }),
          };
        }
      },
      signAssembledTransaction: async (tx: any) => {
        const kit = getSmartAccountKit();
        await kit.sign(tx, {
          credentialId: smartCredentialId || undefined,
        });
      },
      signAuthEntry: async (authEntry: string) => {
        try {
          const kit = getSmartAccountKit();
          let parsed: xdr.SorobanAuthorizationEntry;
          try {
            parsed = xdr.SorobanAuthorizationEntry.fromXDR(authEntry, 'base64');
          } catch {
            const isPreimage = (() => {
              try {
                xdr.HashIdPreimage.fromXDR(authEntry, 'base64');
                return true;
              } catch {
                return false;
              }
            })();

            if (isPreimage) {
              throw new Error(
                'Smart-account signer received HashIdPreimage XDR. This flow must pass a SorobanAuthorizationEntry XDR.'
              );
            }

            throw new Error('Invalid SorobanAuthorizationEntry XDR for smart-account signing.');
          }

          const signed = await kit.signAuthEntry(parsed, {
            credentialId: smartCredentialId || undefined,
          });

          return {
            signedAuthEntry: signed.toXDR('base64'),
            signerAddress: publicKey,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to sign auth entry with passkey';
          return {
            signedAuthEntry: authEntry,
            signerAddress: publicKey,
            error: toWalletError({ message, code: -1 }),
          };
        }
      },
    };

    if (!options?.preferSessionSigner || !options.sessionContractId || NETWORK !== 'testnet') {
      return smartAccountSigner;
    }

    const sessionPhase = options.sessionPhase ?? 'setup';
    const allowProvisioning = sessionPhase !== 'gameplay';

    return {
      ...smartAccountSigner,
      executeAssembledTransaction: async (tx) => {
        const kit = getSmartAccountKit();
        return executeDeadDropWithSessionSigner({
          kit,
          credentialId: smartCredentialId,
          walletContractId: publicKey,
          gameContractId: options.sessionContractId!,
          sessionId: options.sessionId,
          ttlMinutes: options.sessionTtlMinutes ?? DEAD_DROP_SESSION_TTL_MINUTES,
          allowProvisioning,
          tx,
        });
      },
    };
  }, [isConnected, publicKey, walletType, networkPassphrase]);

  const isDevModeAvailable = useCallback(() => supportsDev && DevWalletService.isDevModeAvailable(), [supportsDev]);

  const isDevPlayerAvailable = useCallback(
    (playerNumber: 1 | 2) => supportsDev && DevWalletService.isPlayerAvailable(playerNumber),
    [supportsDev]
  );

  const getCurrentDevPlayer = useCallback(() => {
    if (walletType !== 'dev') return null;
    return devWalletService.getCurrentPlayer();
  }, [walletType]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const unsubscribers: Array<() => void> = [];
    setNetwork(NETWORK, NETWORK_PASSPHRASE);

    const bootstrap = async () => {
      if (supportsSmartAccount) {
        try {
          const kit = getSmartAccountKit();
          const smartSession = await kit.connectWallet();
          if (smartSession && (walletMode === 'smart-account' || !isConnected)) {
            smartCredentialId = smartSession.credentialId;
            clearDeadDropSessionSignerState(kit);
            setWallet(smartSession.contractId, SMART_ACCOUNT_ID, 'smart-account');
            return;
          }
        } catch {
          // noop
        }
      }

      if (supportsWalletKit) {
        try {
          ensureWalletKitInitialized(NETWORK_PASSPHRASE);
          const address = await StellarWalletsKit.getAddress();
          if (typeof address === 'string' && address && (walletMode === 'wallet' || !isConnected)) {
            setWallet(address, WALLET_ID, 'wallet');
          }
        } catch {
          // noop
        }
      }
    };

    if (supportsWalletKit) {
      ensureWalletKitInitialized(NETWORK_PASSPHRASE);

      const unsubscribeState = StellarWalletsKit.on(KitEventType.STATE_UPDATED, (event) => {
        const address = event.payload.address;
        if (typeof address === 'string' && address) {
          setWallet(address, WALLET_ID, 'wallet');
        } else {
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
    }

    bootstrap().catch(() => undefined);

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [
    supportsWalletKit,
    supportsSmartAccount,
    walletMode,
    isConnected,
    walletType,
    setWallet,
    setNetwork,
    storeDisconnect,
  ]);

  const isSmartAccountReady = supportsSmartAccount && smartAccountConfigured();

  useEffect(() => {
    if (walletType === 'smart-account') return;
    clearDeadDropSessionSignerState();
  }, [walletType]);

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
    isSmartAccountReady,

    connect,
    connectWallet,
    connectSmartAccount,
    createSmartAccount,
    refresh,
    connectDev,
    switchPlayer,
    disconnect,
    releaseDeadDropSessionSigner,
    getContractSigner,
    isDevModeAvailable,
    isDevPlayerAvailable,
    getCurrentDevPlayer,
  };
}
