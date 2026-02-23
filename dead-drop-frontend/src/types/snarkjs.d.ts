declare module 'snarkjs' {
  export namespace groth16 {
    export function prove(
      zkey: ArrayBuffer | Uint8Array,
      witness: any
    ): Promise<{
      proof: any;
      publicSignals: string[];
    }>;

    export function verify(
      vkey: any,
      publicSignals: string[],
      proof: any
    ): Promise<boolean>;
  }
}
