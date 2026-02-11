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


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CCMKJGCCNCUFPPDBFIVF6TMFGF5N6KEAHORXDTS7VZKPUIFBAIUJLB34",
  }
} as const


export interface Game {
  commitment1: Buffer;
  commitment2: Buffer;
  current_turn: u32;
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
  5: {message:"AlreadyCommitted"},
  6: {message:"NotYourTurn"},
  7: {message:"InvalidTurn"},
  8: {message:"InvalidImageId"},
  9: {message:"InvalidJournalHash"},
  10: {message:"ProofVerificationFailed"},
  11: {message:"TimeoutNotReached"},
  12: {message:"InvalidDistance"},
  13: {message:"MaxTurnsReached"},
  14: {message:"LobbyNotFound"},
  15: {message:"LobbyAlreadyExists"},
  16: {message:"SelfPlay"}
}


export interface Lobby {
  created_ledger: u32;
  host: string;
  host_points: i128;
}

export type DataKey = {tag: "Game", values: readonly [u32]} | {tag: "Lobby", values: readonly [u32]} | {tag: "GameHubAddress", values: void} | {tag: "Admin", values: void} | {tag: "VerifierId", values: void} | {tag: "PingImageId", values: void};

export enum GameStatus {
  Created = 0,
  Committing = 1,
  Active = 2,
  Completed = 3,
  Timeout = 4,
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
  join_game: ({session_id, joiner, joiner_points}: {session_id: u32, joiner: string, joiner_points: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   */
  start_game: ({session_id, player1, player2, player1_points, player2_points}: {session_id: u32, player1: string, player2: string, player1_points: i128, player2_points: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a submit_ping transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Submit a ping result with ZK proof verification.
   * 
   * The pinging player sends a coordinate to the responder off-chain.
   * The responder computes the Manhattan distance and generates a ZK proof.
   * This method verifies the proof and records the distance.
   * 
   * Journal layout: [session_id(4) || turn(4) || distance(4) || commitment(32)] = 44 bytes LE
   */
  submit_ping: ({session_id, player, turn, distance, x, y, journal_hash, image_id, seal}: {session_id: u32, player: string, turn: u32, distance: u32, x: u32, y: u32, journal_hash: Buffer, image_id: Buffer, seal: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Option<string>>>>

  /**
   * Construct and simulate a set_image_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_image_id: ({new_image_id}: {new_image_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_verifier: ({new_verifier}: {new_verifier: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a commit_secret transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Submit a SHA-256 commitment of the player's secret coordinates.
   * commitment = SHA256(x_le || y_le || salt)   (4 + 4 + 32 = 40 bytes)
   */
  commit_secret: ({session_id, player, commitment}: {session_id: u32, player: string, commitment: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a force_timeout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Force a timeout win if the opponent has been AFK.
   */
  force_timeout: ({session_id, player}: {session_id: u32, player: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, game_hub, verifier_id, ping_image_id}: {admin: string, game_hub: string, verifier_id: string, ping_image_id: Buffer},
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
    return ContractClient.deploy({admin, game_hub, verifier_id, ping_image_id}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAQAAAAAAAAAAAAAABEdhbWUAAAANAAAAAAAAAAtjb21taXRtZW50MQAAAAPuAAAAIAAAAAAAAAALY29tbWl0bWVudDIAAAAD7gAAACAAAAAAAAAADGN1cnJlbnRfdHVybgAAAAQAAAAAAAAAEmxhc3RfYWN0aW9uX2xlZGdlcgAAAAAABAAAAAAAAAAHcGxheWVyMQAAAAATAAAAAAAAABVwbGF5ZXIxX2Jlc3RfZGlzdGFuY2UAAAAAAAAEAAAAAAAAAA5wbGF5ZXIxX3BvaW50cwAAAAAACwAAAAAAAAAHcGxheWVyMgAAAAATAAAAAAAAABVwbGF5ZXIyX2Jlc3RfZGlzdGFuY2UAAAAAAAAEAAAAAAAAAA5wbGF5ZXIyX3BvaW50cwAAAAAACwAAAAAAAAAGc3RhdHVzAAAAAAfQAAAACkdhbWVTdGF0dXMAAAAAAAAAAAAKd2hvc2VfdHVybgAAAAAABAAAAAAAAAAGd2lubmVyAAAAAAPoAAAAEw==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAEAAAAAAAAAAMR2FtZU5vdEZvdW5kAAAAAQAAAAAAAAAJTm90UGxheWVyAAAAAAAAAgAAAAAAAAAQR2FtZUFscmVhZHlFbmRlZAAAAAMAAAAAAAAAEUludmFsaWRHYW1lU3RhdHVzAAAAAAAABAAAAAAAAAAQQWxyZWFkeUNvbW1pdHRlZAAAAAUAAAAAAAAAC05vdFlvdXJUdXJuAAAAAAYAAAAAAAAAC0ludmFsaWRUdXJuAAAAAAcAAAAAAAAADkludmFsaWRJbWFnZUlkAAAAAAAIAAAAAAAAABJJbnZhbGlkSm91cm5hbEhhc2gAAAAAAAkAAAAAAAAAF1Byb29mVmVyaWZpY2F0aW9uRmFpbGVkAAAAAAoAAAAAAAAAEVRpbWVvdXROb3RSZWFjaGVkAAAAAAAACwAAAAAAAAAPSW52YWxpZERpc3RhbmNlAAAAAAwAAAAAAAAAD01heFR1cm5zUmVhY2hlZAAAAAANAAAAAAAAAA1Mb2JieU5vdEZvdW5kAAAAAAAADgAAAAAAAAASTG9iYnlBbHJlYWR5RXhpc3RzAAAAAAAPAAAAAAAAAAhTZWxmUGxheQAAABA=",
        "AAAAAQAAAAAAAAAAAAAABUxvYmJ5AAAAAAAAAwAAAAAAAAAOY3JlYXRlZF9sZWRnZXIAAAAAAAQAAAAAAAAABGhvc3QAAAATAAAAAAAAAAtob3N0X3BvaW50cwAAAAAL",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABgAAAAEAAAAAAAAABEdhbWUAAAABAAAABAAAAAEAAAAAAAAABUxvYmJ5AAAAAAAAAQAAAAQAAAAAAAAAAAAAAA5HYW1lSHViQWRkcmVzcwAAAAAAAAAAAAAAAAAFQWRtaW4AAAAAAAAAAAAAAAAAAApWZXJpZmllcklkAAAAAAAAAAAAAAAAAAtQaW5nSW1hZ2VJZAA=",
        "AAAAAwAAAAAAAAAAAAAACkdhbWVTdGF0dXMAAAAAAAUAAAAAAAAAB0NyZWF0ZWQAAAAAAAAAAAAAAAAKQ29tbWl0dGluZwAAAAAAAQAAAAAAAAAGQWN0aXZlAAAAAAACAAAAAAAAAAlDb21wbGV0ZWQAAAAAAAADAAAAAAAAAAdUaW1lb3V0AAAAAAQ=",
        "AAAAAAAAAAAAAAAHZ2V0X2h1YgAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAAAAAAAHc2V0X2h1YgAAAAABAAAAAAAAAAduZXdfaHViAAAAABMAAAAA",
        "AAAAAAAAAAAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAABtSZWFkLW9ubHkgZ2FtZSBzdGF0ZSBxdWVyeS4AAAAACGdldF9nYW1lAAAAAQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAEAAAPpAAAH0AAAAARHYW1lAAAAAw==",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAABxSZWFkLW9ubHkgbG9iYnkgc3RhdGUgcXVlcnkuAAAACWdldF9sb2JieQAAAAAAAAEAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAABAAAD6QAAB9AAAAAFTG9iYnkAAAAAAAAD",
        "AAAAAAAAAIBKb2luIGFuIGV4aXN0aW5nIGxvYmJ5LiBQbGF5ZXIgMiBqb2lucyB3aXRoIHRoZSByb29tIGNvZGUgKHNlc3Npb25faWQpLgpUaGlzIGlzIHNpbmdsZS1zaWcgYW5kIGNhbGxzIEdhbWUgSHViIHRvIHN0YXJ0IHRoZSBnYW1lLgAAAAlqb2luX2dhbWUAAAAAAAADAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAZqb2luZXIAAAAAABMAAAAAAAAADWpvaW5lcl9wb2ludHMAAAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAJNPcGVuIGEgbG9iYnkgZm9yIGEgZ2FtZSBzZXNzaW9uLiBQbGF5ZXIgMSBjcmVhdGVzIGl0IHdpdGggYSByb29tIGNvZGUgKHNlc3Npb25faWQpLgpUaGlzIGlzIHNpbmdsZS1zaWcgYW5kIGRvZXMgbm90IHJlcXVpcmUgdGhlIG9wcG9uZW50J3MgYWRkcmVzcy4AAAAACW9wZW5fZ2FtZQAAAAAAAAMAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAABGhvc3QAAAATAAAAAAAAAAtob3N0X3BvaW50cwAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAC1TdGFydCBhIG5ldyBnYW1lIHNlc3Npb24gYmV0d2VlbiB0d28gcGxheWVycy4AAAAAAAAKc3RhcnRfZ2FtZQAAAAAABQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAHcGxheWVyMQAAAAATAAAAAAAAAAdwbGF5ZXIyAAAAABMAAAAAAAAADnBsYXllcjFfcG9pbnRzAAAAAAALAAAAAAAAAA5wbGF5ZXIyX3BvaW50cwAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAU9TdWJtaXQgYSBwaW5nIHJlc3VsdCB3aXRoIFpLIHByb29mIHZlcmlmaWNhdGlvbi4KClRoZSBwaW5naW5nIHBsYXllciBzZW5kcyBhIGNvb3JkaW5hdGUgdG8gdGhlIHJlc3BvbmRlciBvZmYtY2hhaW4uClRoZSByZXNwb25kZXIgY29tcHV0ZXMgdGhlIE1hbmhhdHRhbiBkaXN0YW5jZSBhbmQgZ2VuZXJhdGVzIGEgWksgcHJvb2YuClRoaXMgbWV0aG9kIHZlcmlmaWVzIHRoZSBwcm9vZiBhbmQgcmVjb3JkcyB0aGUgZGlzdGFuY2UuCgpKb3VybmFsIGxheW91dDogW3Nlc3Npb25faWQoNCkgfHwgdHVybig0KSB8fCBkaXN0YW5jZSg0KSB8fCBjb21taXRtZW50KDMyKV0gPSA0NCBieXRlcyBMRQAAAAALc3VibWl0X3BpbmcAAAAACQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGcGxheWVyAAAAAAATAAAAAAAAAAR0dXJuAAAABAAAAAAAAAAIZGlzdGFuY2UAAAAEAAAAAAAAAAF4AAAAAAAABAAAAAAAAAABeQAAAAAAAAQAAAAAAAAADGpvdXJuYWxfaGFzaAAAA+4AAAAgAAAAAAAAAAhpbWFnZV9pZAAAA+4AAAAgAAAAAAAAAARzZWFsAAAADgAAAAEAAAPpAAAD6AAAABMAAAAD",
        "AAAAAAAAAAAAAAAMc2V0X2ltYWdlX2lkAAAAAQAAAAAAAAAMbmV3X2ltYWdlX2lkAAAD7gAAACAAAAAA",
        "AAAAAAAAAAAAAAAMc2V0X3ZlcmlmaWVyAAAAAQAAAAAAAAAMbmV3X3ZlcmlmaWVyAAAAEwAAAAA=",
        "AAAAAAAAABhJbml0aWFsaXplIHRoZSBjb250cmFjdC4AAAANX19jb25zdHJ1Y3RvcgAAAAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIZ2FtZV9odWIAAAATAAAAAAAAAAt2ZXJpZmllcl9pZAAAAAATAAAAAAAAAA1waW5nX2ltYWdlX2lkAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAAINTdWJtaXQgYSBTSEEtMjU2IGNvbW1pdG1lbnQgb2YgdGhlIHBsYXllcidzIHNlY3JldCBjb29yZGluYXRlcy4KY29tbWl0bWVudCA9IFNIQTI1Nih4X2xlIHx8IHlfbGUgfHwgc2FsdCkgICAoNCArIDQgKyAzMiA9IDQwIGJ5dGVzKQAAAAANY29tbWl0X3NlY3JldAAAAAAAAAMAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAABnBsYXllcgAAAAAAEwAAAAAAAAAKY29tbWl0bWVudAAAAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAADFGb3JjZSBhIHRpbWVvdXQgd2luIGlmIHRoZSBvcHBvbmVudCBoYXMgYmVlbiBBRksuAAAAAAAADWZvcmNlX3RpbWVvdXQAAAAAAAACAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAZwbGF5ZXIAAAAAABMAAAABAAAD6QAAABMAAAAD" ]),
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
        set_image_id: this.txFromJSON<null>,
        set_verifier: this.txFromJSON<null>,
        commit_secret: this.txFromJSON<Result<void>>,
        force_timeout: this.txFromJSON<Result<string>>
  }
}