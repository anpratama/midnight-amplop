import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  localSecretKey(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  createAuction(context: __compactRuntime.CircuitContext<PS>,
                itemHash__0: Uint8Array,
                reservePrice__0: bigint,
                depositAmount__0: bigint,
                commitDeadline__0: bigint,
                revealDeadline__0: bigint,
                sellerSecret_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  commitBid(context: __compactRuntime.CircuitContext<PS>,
            auctionId_0: Uint8Array,
            bidAmount_0: bigint,
            secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  revealBid(context: __compactRuntime.CircuitContext<PS>,
            auctionId_0: Uint8Array,
            bidAmount_0: bigint,
            secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  finalize(context: __compactRuntime.CircuitContext<PS>,
           auctionId_0: Uint8Array,
           sellerSecret_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  verifyReceipt(context: __compactRuntime.CircuitContext<PS>,
                auctionId_0: Uint8Array,
                winningBid_0: bigint,
                committedCount_0: bigint,
                revealedCount_0: bigint): __compactRuntime.CircuitResults<PS, boolean>;
  getHighestBid(context: __compactRuntime.CircuitContext<PS>,
                auctionId_0: Uint8Array): __compactRuntime.CircuitResults<PS, bigint>;
}

export type ProvableCircuits<PS> = {
  createAuction(context: __compactRuntime.CircuitContext<PS>,
                itemHash__0: Uint8Array,
                reservePrice__0: bigint,
                depositAmount__0: bigint,
                commitDeadline__0: bigint,
                revealDeadline__0: bigint,
                sellerSecret_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  commitBid(context: __compactRuntime.CircuitContext<PS>,
            auctionId_0: Uint8Array,
            bidAmount_0: bigint,
            secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  revealBid(context: __compactRuntime.CircuitContext<PS>,
            auctionId_0: Uint8Array,
            bidAmount_0: bigint,
            secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  finalize(context: __compactRuntime.CircuitContext<PS>,
           auctionId_0: Uint8Array,
           sellerSecret_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  verifyReceipt(context: __compactRuntime.CircuitContext<PS>,
                auctionId_0: Uint8Array,
                winningBid_0: bigint,
                committedCount_0: bigint,
                revealedCount_0: bigint): __compactRuntime.CircuitResults<PS, boolean>;
  getHighestBid(context: __compactRuntime.CircuitContext<PS>,
                auctionId_0: Uint8Array): __compactRuntime.CircuitResults<PS, bigint>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  createAuction(context: __compactRuntime.CircuitContext<PS>,
                itemHash__0: Uint8Array,
                reservePrice__0: bigint,
                depositAmount__0: bigint,
                commitDeadline__0: bigint,
                revealDeadline__0: bigint,
                sellerSecret_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  commitBid(context: __compactRuntime.CircuitContext<PS>,
            auctionId_0: Uint8Array,
            bidAmount_0: bigint,
            secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  revealBid(context: __compactRuntime.CircuitContext<PS>,
            auctionId_0: Uint8Array,
            bidAmount_0: bigint,
            secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  finalize(context: __compactRuntime.CircuitContext<PS>,
           auctionId_0: Uint8Array,
           sellerSecret_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  verifyReceipt(context: __compactRuntime.CircuitContext<PS>,
                auctionId_0: Uint8Array,
                winningBid_0: bigint,
                committedCount_0: bigint,
                revealedCount_0: bigint): __compactRuntime.CircuitResults<PS, boolean>;
  getHighestBid(context: __compactRuntime.CircuitContext<PS>,
                auctionId_0: Uint8Array): __compactRuntime.CircuitResults<PS, bigint>;
}

export type Ledger = {
  readonly auctionCount: bigint;
  auctions: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): { sellerId: Uint8Array,
                                 itemHash: Uint8Array,
                                 reservePrice: bigint,
                                 depositAmount: bigint,
                                 commitDeadline: bigint,
                                 revealDeadline: bigint,
                                 finalized: boolean,
                                 committedCount: bigint,
                                 revealedCount: bigint,
                                 hasLeader: boolean,
                                 highestBid: bigint,
                                 leaderId: Uint8Array,
                                 hasWinner: boolean,
                                 winningBid: bigint,
                                 winnerId: Uint8Array,
                                 forfeitedCount: bigint,
                                 forfeitedAmount: bigint
                               };
    [Symbol.iterator](): Iterator<[Uint8Array, { sellerId: Uint8Array,
  itemHash: Uint8Array,
  reservePrice: bigint,
  depositAmount: bigint,
  commitDeadline: bigint,
  revealDeadline: bigint,
  finalized: boolean,
  committedCount: bigint,
  revealedCount: bigint,
  hasLeader: boolean,
  highestBid: bigint,
  leaderId: Uint8Array,
  hasWinner: boolean,
  winningBid: bigint,
  winnerId: Uint8Array,
  forfeitedCount: bigint,
  forfeitedAmount: bigint
}]>
  };
  commitments: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  deposits: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  revealedBids: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  receipts: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
