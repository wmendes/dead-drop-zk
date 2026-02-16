import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, Fingerprint, Loader2, Wallet as WalletIcon } from 'lucide-react';
import { config } from './config';
import { Layout } from './components/Layout';
import { PhoneFrame } from './components/PhoneFrame';
import { DeadDropLogo } from './components/DeadDropLogo';
import { useWallet } from './hooks/useWallet';
import { DeadDropGame } from './games/dead-drop/DeadDropGame';
import { ProofBenchmark } from './pages/ProofBenchmark';
import type { WalletOperation, WalletStage } from './store/walletSlice';

const GAME_ID = 'dead-drop';
const GAME_TITLE = import.meta.env.VITE_GAME_TITLE || 'Dead Drop';
const GAME_TAGLINE = import.meta.env.VITE_GAME_TAGLINE || 'ZK Scavenger Hunt on Stellar';

const OPERATION_STEPS: Record<WalletOperation, Array<{ stage: WalletStage; label: string }>> = {
  idle: [],
  'connect-wallet': [
    { stage: 'validating', label: 'Preparing connection' },
    { stage: 'opening_wallet', label: 'Approve in wallet' },
    { stage: 'finalizing', label: 'Finalizing' },
  ],
  'connect-passkey': [
    { stage: 'validating', label: 'Checking passkey setup' },
    { stage: 'opening_passkey_prompt', label: 'Approve passkey' },
    { stage: 'finalizing', label: 'Finalizing' },
  ],
  'create-passkey': [
    { stage: 'validating', label: 'Checking passkey setup' },
    { stage: 'opening_passkey_prompt', label: 'Approve passkey' },
    { stage: 'creating_passkey', label: 'Creating credential' },
    { stage: 'deploying_account', label: 'Deploying wallet' },
    { stage: 'finalizing', label: 'Finalizing' },
  ],
  'switch-dev': [
    { stage: 'validating', label: 'Preparing dev wallet' },
    { stage: 'finalizing', label: 'Finalizing' },
  ],
};

function defaultStageMessage(stage: WalletStage): string {
  switch (stage) {
    case 'validating':
      return 'Preparing...';
    case 'opening_wallet':
      return 'Waiting for wallet approval...';
    case 'opening_passkey_prompt':
      return 'Waiting for passkey approval...';
    case 'creating_passkey':
      return 'Creating your passkey...';
    case 'deploying_account':
      return 'Setting up your wallet...';
    case 'finalizing':
      return 'Almost done...';
    case 'done':
      return 'Connected.';
    case 'error':
      return 'Something went wrong.';
    default:
      return 'Ready.';
  }
}

function isNoWalletFoundMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return normalized.includes('no deployed smart account found')
    || normalized.includes('no smart account found')
    || normalized.includes('wallet may not have been deployed yet')
    || normalized.includes('contract not found on-chain');
}

function WalletProgress({
  operation,
  stage,
  message,
  error,
  isConnecting,
  expanded,
  onToggleExpanded,
}: {
  operation: WalletOperation;
  stage: WalletStage;
  message: string | null;
  error: string | null;
  isConnecting: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  if (!isConnecting && !error) return null;

  const steps = OPERATION_STEPS[operation] ?? [];
  const rawActiveIndex = steps.findIndex((entry) => entry.stage === stage);
  const activeIndex = rawActiveIndex >= 0 ? rawActiveIndex : 0;
  const lineMessage = message || error || defaultStageMessage(stage);

  const stepState = (index: number): 'pending' | 'active' | 'complete' | 'error' => {
    if (error) {
      if (index < activeIndex) return 'complete';
      if (index === activeIndex) return 'error';
      return 'pending';
    }
    if (stage === 'done') return 'complete';
    if (index < activeIndex) return 'complete';
    if (index === activeIndex) return 'active';
    return 'pending';
  };

  return (
    <div className={`rounded-xl border p-3 ${error ? 'border-rose-500/30 bg-rose-500/10' : 'border-emerald-500/25 bg-slate-950/80'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {error ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 text-rose-300" />
          ) : (
            <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-emerald-300" />
          )}
          <p aria-live="polite" className={`text-sm ${error ? 'text-rose-200' : 'text-slate-200'}`}>
            {lineMessage}
          </p>
        </div>

        {steps.length > 0 && (
          <button
            type="button"
            onClick={onToggleExpanded}
            className="text-[11px] uppercase tracking-[0.14em] text-slate-400 transition hover:text-slate-200"
          >
            {expanded ? 'Hide details' : 'View details'}
          </button>
        )}
      </div>

      {expanded && steps.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-white/10 pt-3">
          {steps.map((entry, index) => {
            const state = stepState(index);
            const icon = (() => {
              if (state === 'complete') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
              if (state === 'active') return <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-300" />;
              if (state === 'error') return <AlertTriangle className="h-3.5 w-3.5 text-rose-300" />;
              return <Circle className="h-3.5 w-3.5 text-slate-600" />;
            })();

            return (
              <div key={entry.stage} className="flex items-center gap-2">
                {icon}
                <span
                  className={`text-xs ${
                    state === 'complete'
                      ? 'text-emerald-300'
                      : state === 'active'
                        ? 'text-cyan-300'
                        : state === 'error'
                          ? 'text-rose-300'
                          : 'text-slate-500'
                  }`}
                >
                  {entry.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function App() {
  if (new URLSearchParams(window.location.search).has('benchmark')) {
    return <ProofBenchmark />;
  }

  const {
    publicKey,
    isConnected,
    isConnecting,
    error,
    walletMode,
    walletOperation,
    walletStage,
    walletStageMessage,
    connectWallet,
    connectSmartAccount,
    createSmartAccount,
    isSmartAccountReady,
    isWalletAvailable,
  } = useWallet();

  const [smartAccountLabel, setSmartAccountLabel] = useState('');
  const [showCreateAfterNoWallet, setShowCreateAfterNoWallet] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showProgressDetails, setShowProgressDetails] = useState(false);

  const userAddress = publicKey ?? '';
  const contractId = config.contractIds[GAME_ID] || '';
  const hasContract = contractId && contractId !== 'YOUR_CONTRACT_ID';
  const isDevOnlyMode = walletMode === 'dev';
  const supportsPasskey = walletMode === 'smart-account' || walletMode === 'hybrid';
  const supportsWalletKit = walletMode === 'wallet' || walletMode === 'hybrid';
  const canUsePasskey = supportsPasskey && isSmartAccountReady;

  const primaryActionLabel = useMemo(() => {
    if (isDevOnlyMode) return 'Preparing development wallet...';
    if (canUsePasskey) return 'Continue with Passkey';
    if (supportsWalletKit) return 'Continue with Wallet';
    return 'Continue';
  }, [isDevOnlyMode, canUsePasskey, supportsWalletKit]);

  useEffect(() => {
    if (error && isNoWalletFoundMessage(error)) {
      setShowCreateAfterNoWallet(true);
    }
    if (error) {
      setShowProgressDetails(true);
    }
  }, [error]);

  useEffect(() => {
    if (walletOperation !== 'idle' && !error) {
      setShowProgressDetails(false);
    }
  }, [walletOperation, error]);

  useEffect(() => {
    if (isConnected) {
      setShowCreateAfterNoWallet(false);
      setShowCreateForm(false);
      setShowProgressDetails(false);
      setSmartAccountLabel('');
    }
  }, [isConnected]);

  const handlePrimaryContinue = async () => {
    if (isDevOnlyMode || isConnecting) return;
    setShowCreateForm(false);
    if (canUsePasskey) {
      try {
        await connectSmartAccount();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isNoWalletFoundMessage(message)) {
          setShowCreateAfterNoWallet(true);
        }
      }
      return;
    }
    if (supportsWalletKit) {
      await connectWallet().catch(() => undefined);
    }
  };

  const handleCreateWallet = async () => {
    if (isConnecting) return;
    const label = smartAccountLabel.trim();
    if (!label) return;
    await createSmartAccount(label).catch(() => undefined);
  };

  const content = (
    <Layout title={GAME_TITLE} subtitle={GAME_TAGLINE}>
      {!hasContract ? (
        <div className="mx-auto w-full max-w-xl rounded-2xl border border-rose-500/30 bg-slate-950/80 p-6 shadow-xl">
          <h3 className="text-sm font-bold uppercase tracking-[0.16em] text-rose-300">Contract Not Configured</h3>
          <p className="mt-3 text-sm text-slate-300">
            Run <code className="text-amber-300">bun run setup</code> to deploy and configure testnet contract IDs.
          </p>
        </div>
      ) : !isWalletAvailable ? (
        <div className="mx-auto w-full max-w-xl rounded-2xl border border-amber-500/30 bg-slate-950/80 p-6 shadow-xl">
          <h3 className="text-sm font-bold uppercase tracking-[0.16em] text-amber-200">Browser Required</h3>
          <p className="mt-3 text-sm text-slate-300">Wallet and passkey auth are only available in the browser.</p>
        </div>
      ) : !isConnected ? (
        <div className="mx-auto h-full w-full max-w-md">
          <div className="relative flex h-full flex-col overflow-hidden rounded-3xl border border-emerald-500/20 bg-slate-950/80 p-5 shadow-[0_10px_40px_rgba(2,6,23,0.75)]">
            <div className="absolute -top-16 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none" />
            <div className="absolute -bottom-20 right-0 h-48 w-48 rounded-full bg-cyan-500/8 blur-3xl pointer-events-none" />

            <div className="relative flex flex-1 items-center justify-center pb-4">
              <div className="w-full text-center">
                <div className="relative mx-auto h-36 w-36">
                  <div className="absolute inset-0 rounded-full bg-emerald-400/10 blur-2xl" />
                  <DeadDropLogo
                    size={144}
                    className="relative mx-auto drop-shadow-[0_0_20px_rgba(52,211,153,0.35)]"
                  />
                </div>
                <h1 className="mt-4 text-3xl font-black uppercase tracking-[0.24em] text-emerald-300 sm:text-4xl">
                  Dead Drop
                </h1>
                <p className="mt-2 text-[11px] uppercase tracking-[0.2em] text-slate-400">
                  Classified Recovery Operation
                </p>
              </div>
            </div>

            <div className="relative space-y-3 pb-1">
              <button
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-500/14 px-4 py-3 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/22 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  void handlePrimaryContinue();
                }}
                disabled={isDevOnlyMode || isConnecting || (!canUsePasskey && !supportsWalletKit)}
              >
                {isConnecting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : canUsePasskey ? (
                  <Fingerprint className="h-4 w-4" />
                ) : (
                  <WalletIcon className="h-4 w-4" />
                )}
                {primaryActionLabel}
              </button>

              {canUsePasskey && supportsWalletKit && (
                <button
                  type="button"
                  className="w-full text-xs text-slate-400 underline-offset-4 transition hover:text-slate-200 hover:underline"
                  onClick={() => connectWallet().catch(() => undefined)}
                  disabled={isConnecting}
                >
                  Use another wallet instead
                </button>
              )}

              {showCreateAfterNoWallet && canUsePasskey && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                  <p className="text-xs text-amber-100">No wallet found for this passkey.</p>
                  {!showCreateForm ? (
                    <button
                      type="button"
                      className="mt-2 text-xs font-semibold text-amber-200 underline-offset-4 transition hover:text-amber-100 hover:underline"
                      onClick={() => {
                        setShowCreateForm(true);
                        if (!smartAccountLabel) setSmartAccountLabel('My Wallet');
                      }}
                      disabled={isConnecting}
                    >
                      Create new passkey wallet
                    </button>
                  ) : (
                    <div className="mt-2 space-y-2">
                      <input
                        className="spy-input py-2 text-sm"
                        value={smartAccountLabel}
                        onChange={(event) => setSmartAccountLabel(event.target.value)}
                        placeholder="Wallet name"
                        disabled={isConnecting}
                      />
                      <button
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-amber-300/40 bg-amber-500/12 px-4 py-2.5 text-xs font-semibold text-amber-100 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => {
                          void handleCreateWallet();
                        }}
                        disabled={isConnecting || !smartAccountLabel.trim()}
                      >
                        {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
                        Create wallet
                      </button>
                    </div>
                  )}
                </div>
              )}

              <WalletProgress
                operation={walletOperation}
                stage={walletStage}
                message={walletStageMessage}
                error={error}
                isConnecting={isConnecting}
                expanded={showProgressDetails}
                onToggleExpanded={() => setShowProgressDetails((prev) => !prev)}
              />
            </div>
          </div>
        </div>
      ) : (
        <>
          <DeadDropGame
            userAddress={userAddress}
            currentEpoch={1}
            availablePoints={1000000000n}
            onStandingsRefresh={() => {}}
            onGameComplete={() => {}}
          />
        </>
      )}
    </Layout>
  );

  return <PhoneFrame>{content}</PhoneFrame>;
}
