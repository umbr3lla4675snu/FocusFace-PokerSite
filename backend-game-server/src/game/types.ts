export type Street = "waiting" | "preflop" | "flop" | "turn" | "river" | "showdown";

export type PlayerActionType = "fold" | "check" | "call" | "raise";
export type AutoActionType = "timeout_check" | "timeout_fold";
export type ActionType = PlayerActionType | AutoActionType;

export interface HandActionInput {
  actionType: PlayerActionType;
  amount?: number;
}

export interface Card {
  rank: string;
  suit: "S" | "H" | "D" | "C";
}

export interface PlayerState {
  userId: string;
  nickname: string;
  socketId: string;
  seatNo: number;
  stack: number;
  isReady: boolean;
  isFolded: boolean;
  hasActedThisRound: boolean;
  contribution: number;
  totalContribution: number;
  holeCards: Card[];
}

export interface SidePot {
  amount: number;
  eligibleSeatNos: number[];
}

export interface BlindLevelConfig {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  durationMinutes: number;
}

export interface HandState {
  handId: string;
  street: Street;
  dealerSeatNo: number;
  smallBlindSeatNo: number;
  bigBlindSeatNo: number;
  blindLevelIndex: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  deck: Card[];
  communityCards: Card[];
  pot: number;
  currentBet: number;
  minRaise: number;
  sidePots: SidePot[];
  actionTimeoutMs: number;
  actionDeadlineAt: number | null;
  currentTurnSeatNo: number | null;
}

export interface TableState {
  tableId: string;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  blindLevels: BlindLevelConfig[];
  pendingBlindLevels: BlindLevelConfig[];
  blindLevelIndex: number;
  blindLevelStartedAt: number | null;
  blindLevelEndsAt: number | null;
  buttonSeatNo: number | null;
  hostUserId: string | null;
  actionTimeoutMs: number;
  players: PlayerState[];
  hand: HandState | null;
}

export interface PublicPlayerState {
  userId: string;
  nickname: string;
  seatNo: number;
  stack: number;
  isReady: boolean;
  isFolded: boolean;
  isHost: boolean;
  contribution: number;
  totalContribution: number;
  holeCardsCount: number;
}

export interface PublicHandState {
  handId: string;
  street: Street;
  dealerSeatNo: number;
  smallBlindSeatNo: number;
  bigBlindSeatNo: number;
  blindLevelIndex: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  communityCards: Card[];
  pot: number;
  currentBet: number;
  minRaise: number;
  sidePots: SidePot[];
  actionTimeoutMs: number;
  actionDeadlineAt: number | null;
  currentTurnSeatNo: number | null;
}

export interface PublicTableState {
  tableId: string;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  blindLevels: BlindLevelConfig[];
  pendingBlindLevels: BlindLevelConfig[];
  blindLevelIndex: number;
  blindLevelStartedAt: number | null;
  blindLevelEndsAt: number | null;
  buttonSeatNo: number | null;
  hostUserId: string | null;
  players: PublicPlayerState[];
  hand: PublicHandState | null;
}

export interface PlayerPrivateState {
  seatNo: number;
  holeCards: Card[];
}
