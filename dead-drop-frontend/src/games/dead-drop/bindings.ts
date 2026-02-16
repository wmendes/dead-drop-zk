import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}





export interface Game {
  current_turn: u32;
  drop_commitment: Buffer;
  last_action_ledger: u32;
  player1: string;
  player1_best_distance: u32;
  player1_points: i128;
  player2: string;
  player2_best_distance: u32;
  player2_points: i128;
  status: GameStatus;
  whose_turn: u32;
  winner: Option<string>;
}

export const Errors = {
  1: {message:"GameNotFound"},
  2: {message:"NotPlayer"},
  3: {message:"GameAlreadyEnded"},
  4: {message:"InvalidGameStatus"},
  6: {message:"NotYourTurn"},
  7: {message:"InvalidTurn"},
  8: {message:"InvalidPublicInputs"},
  10: {message:"ProofVerificationFailed"},
  11: {message:"TimeoutNotReached"},
  12: {message:"InvalidDistance"},
  13: {message:"MaxTurnsReached"},
  14: {message:"LobbyNotFound"},
  15: {message:"LobbyAlreadyExists"},
  16: {message:"SelfPlay"},
  17: {message:"RandomnessVerificationFailed"}
}


export interface Lobby {
  created_ledger: u32;
  host: string;
  host_points: i128;
}

export type DataKey = {tag: "Game", values: readonly [u32]} | {tag: "Lobby", values: readonly [u32]} | {tag: "GameHubAddress", values: void} | {tag: "Admin", values: void} | {tag: "VerifierId", values: void} | {tag: "RandomnessVerifierId", values: void};

export enum GameStatus {
  Created = 0,
  Active = 1,
  Completed = 2,
  Timeout = 3,
}

export interface Client {
  /**
   * Construct and simulate a get_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_hub: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_hub: ({new_hub}: {new_hub: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only game state query.
   */
  get_game: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Game>>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_lobby transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only lobby state query.
   */
  get_lobby: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Lobby>>>

  /**
   * Construct and simulate a join_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Join an existing lobby. Player 2 joins with the room code (session_id).
   * This is single-sig and calls Game Hub to start the game.
   */
  join_game: ({session_id, joiner, joiner_points, randomness_output, drop_commitment, randomness_signature}: {session_id: u32, joiner: string, joiner_points: i128, randomness_output: Buffer, drop_commitment: Buffer, randomness_signature: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a open_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Open a lobby for a game session. Player 1 creates it with a room code (session_id).
   * This is single-sig and does not require the opponent's address.
   */
  open_game: ({session_id, host, host_points}: {session_id: u32, host: string, host_points: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a start_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Start a new game session between two players.
   * 
   * This is the legacy multi-sig flow where both players are known up-front.
   */
  start_game: ({session_id, player1, player2, player1_points, player2_points, randomness_output, drop_commitment, randomness_signature}: {session_id: u32, player1: string, player2: string, player1_points: i128, player2_points: i128, randomness_output: Buffer, drop_commitment: Buffer, randomness_signature: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a submit_ping transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Submit a ping result with ZK proof verification (Noir + UltraHonk).
   * 
   * Public inputs layout (6 x 32-byte big-endian field elements):
   * [session_id, turn, ping_x, ping_y, drop_commitment, expected_distance]
   */
  submit_ping: ({session_id, player, turn, distance, ping_x, ping_y, proof, public_inputs}: {session_id: u32, player: string, turn: u32, distance: u32, ping_x: u32, ping_y: u32, proof: Buffer, public_inputs: Array<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Option<string>>>>

  /**
   * Construct and simulate a set_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_verifier: ({new_verifier}: {new_verifier: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a force_timeout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Force a timeout win if the opponent has been AFK.
   */
  force_timeout: ({session_id, player}: {session_id: u32, player: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a get_randomness_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_randomness_verifier: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_randomness_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_randomness_verifier: ({new_verifier}: {new_verifier: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, game_hub, verifier_id, randomness_verifier_id}: {admin: string, game_hub: string, verifier_id: string, randomness_verifier_id: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, game_hub, verifier_id, randomness_verifier_id}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAQAAAAAAAAAAAAAABEdhbWUAAAAMAAAAAAAAAAxjdXJyZW50X3R1cm4AAAAEAAAAAAAAAA9kcm9wX2NvbW1pdG1lbnQAAAAD7gAAACAAAAAAAAAAEmxhc3RfYWN0aW9uX2xlZGdlcgAAAAAABAAAAAAAAAAHcGxheWVyMQAAAAATAAAAAAAAABVwbGF5ZXIxX2Jlc3RfZGlzdGFuY2UAAAAAAAAEAAAAAAAAAA5wbGF5ZXIxX3BvaW50cwAAAAAACwAAAAAAAAAHcGxheWVyMgAAAAATAAAAAAAAABVwbGF5ZXIyX2Jlc3RfZGlzdGFuY2UAAAAAAAAEAAAAAAAAAA5wbGF5ZXIyX3BvaW50cwAAAAAACwAAAAAAAAAGc3RhdHVzAAAAAAfQAAAACkdhbWVTdGF0dXMAAAAAAAAAAAAKd2hvc2VfdHVybgAAAAAABAAAAAAAAAAGd2lubmVyAAAAAAPoAAAAEw==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAADwAAAAAAAAAMR2FtZU5vdEZvdW5kAAAAAQAAAAAAAAAJTm90UGxheWVyAAAAAAAAAgAAAAAAAAAQR2FtZUFscmVhZHlFbmRlZAAAAAMAAAAAAAAAEUludmFsaWRHYW1lU3RhdHVzAAAAAAAABAAAAAAAAAALTm90WW91clR1cm4AAAAABgAAAAAAAAALSW52YWxpZFR1cm4AAAAABwAAAAAAAAATSW52YWxpZFB1YmxpY0lucHV0cwAAAAAIAAAAAAAAABdQcm9vZlZlcmlmaWNhdGlvbkZhaWxlZAAAAAAKAAAAAAAAABFUaW1lb3V0Tm90UmVhY2hlZAAAAAAAAAsAAAAAAAAAD0ludmFsaWREaXN0YW5jZQAAAAAMAAAAAAAAAA9NYXhUdXJuc1JlYWNoZWQAAAAADQAAAAAAAAANTG9iYnlOb3RGb3VuZAAAAAAAAA4AAAAAAAAAEkxvYmJ5QWxyZWFkeUV4aXN0cwAAAAAADwAAAAAAAAAIU2VsZlBsYXkAAAAQAAAAAAAAABxSYW5kb21uZXNzVmVyaWZpY2F0aW9uRmFpbGVkAAAAEQ==",
        "AAAAAQAAAAAAAAAAAAAABUxvYmJ5AAAAAAAAAwAAAAAAAAAOY3JlYXRlZF9sZWRnZXIAAAAAAAQAAAAAAAAABGhvc3QAAAATAAAAAAAAAAtob3N0X3BvaW50cwAAAAAL",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABgAAAAEAAAAAAAAABEdhbWUAAAABAAAABAAAAAEAAAAAAAAABUxvYmJ5AAAAAAAAAQAAAAQAAAAAAAAAAAAAAA5HYW1lSHViQWRkcmVzcwAAAAAAAAAAAAAAAAAFQWRtaW4AAAAAAAAAAAAAAAAAAApWZXJpZmllcklkAAAAAAAAAAAAAAAAABRSYW5kb21uZXNzVmVyaWZpZXJJZA==",
        "AAAAAwAAAAAAAAAAAAAACkdhbWVTdGF0dXMAAAAAAAQAAAAAAAAAB0NyZWF0ZWQAAAAAAAAAAAAAAAAGQWN0aXZlAAAAAAABAAAAAAAAAAlDb21wbGV0ZWQAAAAAAAACAAAAAAAAAAdUaW1lb3V0AAAAAAM=",
        "AAAAAAAAAAAAAAAHZ2V0X2h1YgAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAAAAAAAHc2V0X2h1YgAAAAABAAAAAAAAAAduZXdfaHViAAAAABMAAAAA",
        "AAAAAAAAAAAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAABtSZWFkLW9ubHkgZ2FtZSBzdGF0ZSBxdWVyeS4AAAAACGdldF9nYW1lAAAAAQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAEAAAPpAAAH0AAAAARHYW1lAAAAAw==",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAABxSZWFkLW9ubHkgbG9iYnkgc3RhdGUgcXVlcnkuAAAACWdldF9sb2JieQAAAAAAAAEAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAABAAAD6QAAB9AAAAAFTG9iYnkAAAAAAAAD",
        "AAAAAAAAAIBKb2luIGFuIGV4aXN0aW5nIGxvYmJ5LiBQbGF5ZXIgMiBqb2lucyB3aXRoIHRoZSByb29tIGNvZGUgKHNlc3Npb25faWQpLgpUaGlzIGlzIHNpbmdsZS1zaWcgYW5kIGNhbGxzIEdhbWUgSHViIHRvIHN0YXJ0IHRoZSBnYW1lLgAAAAlqb2luX2dhbWUAAAAAAAAGAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAZqb2luZXIAAAAAABMAAAAAAAAADWpvaW5lcl9wb2ludHMAAAAAAAALAAAAAAAAABFyYW5kb21uZXNzX291dHB1dAAAAAAAA+4AAAAgAAAAAAAAAA9kcm9wX2NvbW1pdG1lbnQAAAAD7gAAACAAAAAAAAAAFHJhbmRvbW5lc3Nfc2lnbmF0dXJlAAAD7gAAAEAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAJNPcGVuIGEgbG9iYnkgZm9yIGEgZ2FtZSBzZXNzaW9uLiBQbGF5ZXIgMSBjcmVhdGVzIGl0IHdpdGggYSByb29tIGNvZGUgKHNlc3Npb25faWQpLgpUaGlzIGlzIHNpbmdsZS1zaWcgYW5kIGRvZXMgbm90IHJlcXVpcmUgdGhlIG9wcG9uZW50J3MgYWRkcmVzcy4AAAAACW9wZW5fZ2FtZQAAAAAAAAMAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAABGhvc3QAAAATAAAAAAAAAAtob3N0X3BvaW50cwAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAHdTdGFydCBhIG5ldyBnYW1lIHNlc3Npb24gYmV0d2VlbiB0d28gcGxheWVycy4KClRoaXMgaXMgdGhlIGxlZ2FjeSBtdWx0aS1zaWcgZmxvdyB3aGVyZSBib3RoIHBsYXllcnMgYXJlIGtub3duIHVwLWZyb250LgAAAAAKc3RhcnRfZ2FtZQAAAAAACAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAHcGxheWVyMQAAAAATAAAAAAAAAAdwbGF5ZXIyAAAAABMAAAAAAAAADnBsYXllcjFfcG9pbnRzAAAAAAALAAAAAAAAAA5wbGF5ZXIyX3BvaW50cwAAAAAACwAAAAAAAAARcmFuZG9tbmVzc19vdXRwdXQAAAAAAAPuAAAAIAAAAAAAAAAPZHJvcF9jb21taXRtZW50AAAAA+4AAAAgAAAAAAAAABRyYW5kb21uZXNzX3NpZ25hdHVyZQAAA+4AAABAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAMlTdWJtaXQgYSBwaW5nIHJlc3VsdCB3aXRoIFpLIHByb29mIHZlcmlmaWNhdGlvbiAoTm9pciArIFVsdHJhSG9uaykuCgpQdWJsaWMgaW5wdXRzIGxheW91dCAoNiB4IDMyLWJ5dGUgYmlnLWVuZGlhbiBmaWVsZCBlbGVtZW50cyk6CltzZXNzaW9uX2lkLCB0dXJuLCBwaW5nX3gsIHBpbmdfeSwgZHJvcF9jb21taXRtZW50LCBleHBlY3RlZF9kaXN0YW5jZV0AAAAAAAALc3VibWl0X3BpbmcAAAAACAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGcGxheWVyAAAAAAATAAAAAAAAAAR0dXJuAAAABAAAAAAAAAAIZGlzdGFuY2UAAAAEAAAAAAAAAAZwaW5nX3gAAAAAAAQAAAAAAAAABnBpbmdfeQAAAAAABAAAAAAAAAAFcHJvb2YAAAAAAAAOAAAAAAAAAA1wdWJsaWNfaW5wdXRzAAAAAAAD6gAAA+4AAAAgAAAAAQAAA+kAAAPoAAAAEwAAAAM=",
        "AAAAAAAAAAAAAAAMc2V0X3ZlcmlmaWVyAAAAAQAAAAAAAAAMbmV3X3ZlcmlmaWVyAAAAEwAAAAA=",
        "AAAAAAAAABhJbml0aWFsaXplIHRoZSBjb250cmFjdC4AAAANX19jb25zdHJ1Y3RvcgAAAAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIZ2FtZV9odWIAAAATAAAAAAAAAAt2ZXJpZmllcl9pZAAAAAATAAAAAAAAABZyYW5kb21uZXNzX3ZlcmlmaWVyX2lkAAAAAAATAAAAAA==",
        "AAAAAAAAADFGb3JjZSBhIHRpbWVvdXQgd2luIGlmIHRoZSBvcHBvbmVudCBoYXMgYmVlbiBBRksuAAAAAAAADWZvcmNlX3RpbWVvdXQAAAAAAAACAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAZwbGF5ZXIAAAAAABMAAAABAAAD6QAAABMAAAAD",
        "AAAAAAAAAAAAAAAXZ2V0X3JhbmRvbW5lc3NfdmVyaWZpZXIAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAAAAAAAXc2V0X3JhbmRvbW5lc3NfdmVyaWZpZXIAAAAAAQAAAAAAAAAMbmV3X3ZlcmlmaWVyAAAAEwAAAAA=" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_hub: this.txFromJSON<string>,
        set_hub: this.txFromJSON<null>,
        upgrade: this.txFromJSON<null>,
        get_game: this.txFromJSON<Result<Game>>,
        get_admin: this.txFromJSON<string>,
        get_lobby: this.txFromJSON<Result<Lobby>>,
        join_game: this.txFromJSON<Result<void>>,
        open_game: this.txFromJSON<Result<void>>,
        set_admin: this.txFromJSON<null>,
        start_game: this.txFromJSON<Result<void>>,
        submit_ping: this.txFromJSON<Result<Option<string>>>,
        set_verifier: this.txFromJSON<null>,
        force_timeout: this.txFromJSON<Result<string>>,
        get_randomness_verifier: this.txFromJSON<string>,
        set_randomness_verifier: this.txFromJSON<null>
  }
}