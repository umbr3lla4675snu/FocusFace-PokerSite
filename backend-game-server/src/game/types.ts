export type Street = "waiting" | "preflop" | "showdown";

export type ActionType = "fold" | "check" | "call";

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
  holeCards: Card[];
}

export interface HandState {
  handId: string;
  street: Street;
  deck: Card[];
  communityCards: Card[];
  pot: number;
  currentBet: number;
  currentTurnSeatNo: number | null;
}

export interface TableState {
  tableId: string;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
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
  contribution: number;
  holeCardsCount: number;
}

export interface PublicHandState {
  handId: string;
  street: Street;
  communityCards: Card[];
  pot: number;
  currentBet: number;
  currentTurnSeatNo: number | null;
}

export interface PublicTableState {
  tableId: string;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  players: PublicPlayerState[];
  hand: PublicHandState | null;
}

export interface PlayerPrivateState {
  seatNo: number;
  holeCards: Card[];
}
