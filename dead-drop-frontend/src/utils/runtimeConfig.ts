export interface RuntimeConfig {
  rpcUrl?: string;
  networkPassphrase?: string;
  contractIds?: Record<string, string>;
  simulationSourceAddress?: string;
  walletMode?: 'dev' | 'wallet' | 'smart-account' | 'hybrid';
  smartAccountWasmHash?: string;
  smartAccountWebauthnVerifierAddress?: string;
  smartAccountRpName?: string;
  deadDropProverUrl?: string;
  deadDropRelayerUrl?: string;
  deadDropVerifierContractId?: string;
  deadDropPingImageId?: string;
  deadDropVerifierSelectorHex?: string;
}

export function getRuntimeConfig(): RuntimeConfig | null {
  if (typeof globalThis === 'undefined') return null;
  const config = (globalThis as { __STELLAR_GAME_STUDIO_CONFIG__?: unknown })
    .__STELLAR_GAME_STUDIO_CONFIG__;
  if (!config || typeof config !== 'object') return null;
  return config as RuntimeConfig;
}
