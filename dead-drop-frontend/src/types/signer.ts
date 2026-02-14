/**
 * Contract Signer interface for Stellar SDK bindings
 * Compatible with both Freighter wallet and dev wallets
 */
import type { WalletError } from '@stellar/stellar-sdk/contract';
import type { AssembledTransaction } from '@stellar/stellar-sdk/contract';

export interface ContractSigner {
  /**
   * Sign a transaction XDR
   */
  signTransaction: (
    xdr: string,
    opts?: {
      networkPassphrase?: string;
      address?: string;
      submit?: boolean;
      submitUrl?: string;
    }
  ) => Promise<{
    signedTxXdr: string;
    signerAddress?: string;
    error?: WalletError;
  }>;

  /**
   * Sign an auth entry for contract invocations
   */
  signAuthEntry: (
    authEntry: string,
    opts?: {
      networkPassphrase?: string;
      address?: string;
    }
  ) => Promise<{
    signedAuthEntry: string;
    signerAddress?: string;
    error?: WalletError;
  }>;

  /**
   * Optional hook for signers that can sign assembled transactions directly
   * (e.g. smart-account passkey flows) before custom submission.
   */
  signAssembledTransaction?: (tx: AssembledTransaction<unknown>) => Promise<void>;
}
