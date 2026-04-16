import { v4 as uuidv4 } from "uuid";
import { createDeck, shuffleDeck } from "./deck";
import {
  ActionType,
  Card,
  HandState,
  PlayerPrivateState,
  PlayerState,
  Street,
  PublicTableState,
  TableState,
} from "./types";

function findNextTurnSeat(players: PlayerState[], fromSeatNo: number): number | null {
  const candidates = players
    .filter((p) => p.holeCards.length === 2 && !p.isFolded && p.stack >= 0)
    .sort((a, b) => a.seatNo - b.seatNo);

  if (candidates.length === 0) {
    return null;
  }

  const next = candidates.find((p) => p.seatNo > fromSeatNo);
  return next ? next.seatNo : candidates[0].seatNo;
}

function resetRoundActionFlags(players: PlayerState[]): void {
  for (const player of players) {
    if (!player.isFolded) {
      player.hasActedThisRound = false;
    }
  }
}

function getHandPlayers(players: PlayerState[]): PlayerState[] {
  return players.filter((player) => player.holeCards.length === 2);
}

function getActiveHandPlayers(players: PlayerState[]): PlayerState[] {
  return getHandPlayers(players).filter((player) => !player.isFolded);
}

function firstActiveSeat(players: PlayerState[]): number | null {
  const active = getActiveHandPlayers(players)
    .slice()
    .sort((a, b) => a.seatNo - b.seatNo);

  return active[0]?.seatNo ?? null;
}

function dealCommunityCards(deck: Card[], count: number): Card[] {
  const burn = deck.shift();
  if (!burn) {
    throw new Error("Deck underflow while burning card");
  }

  const cards: Card[] = [];
  for (let i = 0; i < count; i += 1) {
    const card = deck.shift();
    if (!card) {
      throw new Error("Deck underflow while dealing community cards");
    }
    cards.push(card);
  }

  return cards;
}

function nextStreet(street: Street): Street | null {
  switch (street) {
    case "preflop":
      return "flop";
    case "flop":
      return "turn";
    case "turn":
      return "river";
    case "river":
      return "showdown";
    default:
      return null;
  }
}

export class TableManager {
  private readonly tables = new Map<string, TableState>();

  constructor() {
    this.tables.set("default", {
      tableId: "default",
      maxPlayers: 6,
      smallBlind: 10,
      bigBlind: 20,
      players: [],
      hand: null,
    });
  }

  join(tableId: string, userId: string, nickname: string, socketId: string): TableState {
    const table = this.getTable(tableId);

    const existing = table.players.find((p) => p.userId === userId);
    if (existing) {
      existing.socketId = socketId;
      existing.nickname = nickname;
      return table;
    }

    if (table.players.length >= table.maxPlayers) {
      throw new Error("Table is full");
    }

    const usedSeats = new Set(table.players.map((p) => p.seatNo));
    let seatNo = 1;
    while (usedSeats.has(seatNo) && seatNo <= table.maxPlayers) {
      seatNo += 1;
    }

    if (seatNo > table.maxPlayers) {
      throw new Error("No seat available");
    }

    table.players.push({
      userId,
      nickname,
      socketId,
      seatNo,
      stack: 1000,
      isReady: false,
      isFolded: false,
      hasActedThisRound: false,
      contribution: 0,
      holeCards: [],
    });

    table.players.sort((a, b) => a.seatNo - b.seatNo);
    return table;
  }

  leave(tableId: string, userId: string): TableState {
    const table = this.getTable(tableId);
    table.players = table.players.filter((p) => p.userId !== userId);
    if (table.players.length < 2) {
      table.hand = null;
    }
    return table;
  }

  markReady(tableId: string, userId: string): TableState {
    const table = this.getTable(tableId);
    const player = table.players.find((p) => p.userId === userId);
    if (!player) {
      throw new Error("Player not found");
    }

    player.isReady = true;

    const readyPlayers = table.players.filter((p) => p.isReady);
    if (!table.hand && readyPlayers.length >= 2) {
      this.startHand(table);
    }

    return table;
  }

  applyAction(
    tableId: string,
    userId: string,
    actionType: ActionType
  ): { table: TableState; result: string } {
    const table = this.getTable(tableId);
    if (
      !table.hand ||
      table.hand.street === "waiting" ||
      table.hand.street === "showdown"
    ) {
      throw new Error("No active hand");
    }

    const actor = table.players.find((p) => p.userId === userId);
    if (!actor) {
      throw new Error("Player not found");
    }

    if (actor.holeCards.length !== 2) {
      throw new Error("Player is not participating in this hand");
    }

    if (table.hand.currentTurnSeatNo !== actor.seatNo) {
      throw new Error("Not your turn");
    }

    if (actor.isFolded) {
      throw new Error("Folded player cannot act");
    }

    switch (actionType) {
      case "fold": {
        actor.isFolded = true;
        actor.hasActedThisRound = true;
        break;
      }
      case "check": {
        if (actor.contribution !== table.hand.currentBet) {
          throw new Error("Cannot check when facing a bet");
        }
        actor.hasActedThisRound = true;
        break;
      }
      case "call": {
        const toCall = table.hand.currentBet - actor.contribution;
        if (toCall < 0) {
          throw new Error("Invalid call amount");
        }
        if (toCall > actor.stack) {
          throw new Error("Insufficient stack to call");
        }

        actor.stack -= toCall;
        actor.contribution += toCall;
        table.hand.pot += toCall;
        actor.hasActedThisRound = true;
        break;
      }
      default:
        throw new Error("Unsupported action");
    }

    const activePlayers = getActiveHandPlayers(table.players);

    if (activePlayers.length === 1) {
      const winner = activePlayers[0];
      winner.stack += table.hand.pot;
      const result = `${winner.nickname} wins by fold`;
      this.finishHand(table);
      return { table, result };
    }

    const everyoneMatched = activePlayers.every((p) => p.contribution === table.hand?.currentBet);
    const everyoneActed = activePlayers.every((p) => p.hasActedThisRound);

    if (everyoneMatched && everyoneActed) {
      const streetAdvanced = this.advanceStreet(table);
      if (!streetAdvanced) {
        this.finishHandWithoutJudging(table, activePlayers);
        return { table, result: "hand finished without showdown judging" };
      }

      return { table, result: `street advanced to ${table.hand.street}` };
    }

    const nextSeat = findNextTurnSeat(table.players, actor.seatNo);
    table.hand.currentTurnSeatNo = nextSeat;

    return { table, result: "action applied" };
  }

  getPublicTableState(tableId: string): PublicTableState {
    const table = this.getTable(tableId);
    return {
      tableId: table.tableId,
      maxPlayers: table.maxPlayers,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      players: table.players.map((p) => ({
        userId: p.userId,
        nickname: p.nickname,
        seatNo: p.seatNo,
        stack: p.stack,
        isReady: p.isReady,
        isFolded: p.isFolded,
        contribution: p.contribution,
        holeCardsCount: p.holeCards.length,
      })),
      hand: table.hand
        ? {
            handId: table.hand.handId,
            street: table.hand.street,
            communityCards: table.hand.communityCards,
            pot: table.hand.pot,
            currentBet: table.hand.currentBet,
            currentTurnSeatNo: table.hand.currentTurnSeatNo,
          }
        : null,
    };
  }

  getPrivateState(tableId: string, userId: string): PlayerPrivateState | null {
    const table = this.getTable(tableId);
    const player = table.players.find((p) => p.userId === userId);
    if (!player || !table.hand) {
      return null;
    }

    return {
      seatNo: player.seatNo,
      holeCards: player.holeCards,
    };
  }

  private getTable(tableId: string): TableState {
    const table = this.tables.get(tableId);
    if (!table) {
      throw new Error(`Table not found: ${tableId}`);
    }
    return table;
  }

  private startHand(table: TableState): void {
    const readyPlayers = table.players.filter((p) => p.isReady);
    if (readyPlayers.length < 2) {
      return;
    }

    const deck = shuffleDeck(createDeck());

    for (const player of table.players) {
      player.isFolded = false;
      player.hasActedThisRound = false;
      player.contribution = 0;
      player.holeCards = [];
      if (player.isReady) {
        const first = deck.shift();
        const second = deck.shift();
        if (!first || !second) {
          throw new Error("Deck underflow while dealing cards");
        }
        player.holeCards = [first, second];
      }
    }

    const firstTurnSeatNo = readyPlayers.slice().sort((a, b) => a.seatNo - b.seatNo)[0]?.seatNo;

    const hand: HandState = {
      handId: uuidv4(),
      street: "preflop",
      deck,
      communityCards: [],
      pot: 0,
      currentBet: 0,
      currentTurnSeatNo: firstTurnSeatNo ?? null,
    };

    table.hand = hand;
  }

  private advanceStreet(table: TableState): boolean {
    if (!table.hand) {
      return false;
    }

    const next = nextStreet(table.hand.street);
    if (!next || next === "showdown") {
      return false;
    }

    if (next === "flop") {
      table.hand.communityCards.push(...dealCommunityCards(table.hand.deck, 3));
    } else {
      table.hand.communityCards.push(...dealCommunityCards(table.hand.deck, 1));
    }

    table.hand.street = next;
    table.hand.currentBet = 0;
    for (const player of getHandPlayers(table.players)) {
      player.contribution = 0;
    }
    resetRoundActionFlags(getHandPlayers(table.players));
    table.hand.currentTurnSeatNo = firstActiveSeat(table.players);

    return true;
  }

  private finishHandWithoutJudging(table: TableState, activePlayers: PlayerState[]): void {
    if (table.hand && activePlayers.length > 0) {
      const pot = table.hand.pot;
      const share = Math.floor(pot / activePlayers.length);
      const remainder = pot % activePlayers.length;

      for (const player of activePlayers) {
        player.stack += share;
      }

      if (remainder > 0) {
        activePlayers
          .slice()
          .sort((a, b) => a.seatNo - b.seatNo)[0].stack += remainder;
      }
    }

    this.finishHand(table);
  }

  private finishHand(table: TableState): void {
    table.hand = null;
    for (const player of table.players) {
      player.isReady = false;
      player.isFolded = false;
      player.hasActedThisRound = false;
      player.contribution = 0;
      player.holeCards = [];
    }
  }
}
