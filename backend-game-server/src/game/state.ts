import { v4 as uuidv4 } from "uuid";
import { createDeck, shuffleDeck } from "./deck";
import {
  ActionType,
  AutoActionType,
  BlindLevelConfig,
  Card,
  HandActionInput,
  HandState,
  PlayerPrivateState,
  PlayerState,
  PublicTableState,
  SidePot,
  Street,
  TableState,
} from "./types";

const MIN_PLAYERS_TO_START_HAND = 2;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const MIN_BLIND = 1;
const MAX_BLIND = 100000;
const MIN_LEVEL_DURATION_MINUTES = 1;
const MAX_LEVEL_DURATION_MINUTES = 1440;

function cloneBlindLevels(levels: BlindLevelConfig[]): BlindLevelConfig[] {
  return levels.map((level) => ({ ...level }));
}

function normalizeBlindLevel(level: BlindLevelConfig): BlindLevelConfig {
  if (!Number.isInteger(level.smallBlind) || level.smallBlind < MIN_BLIND || level.smallBlind > MAX_BLIND) {
    throw new Error(`smallBlind must be an integer between ${MIN_BLIND} and ${MAX_BLIND}`);
  }
  if (!Number.isInteger(level.bigBlind) || level.bigBlind < level.smallBlind || level.bigBlind > MAX_BLIND) {
    throw new Error(`bigBlind must be an integer between smallBlind and ${MAX_BLIND}`);
  }
  if (!Number.isInteger(level.ante) || level.ante < 0 || level.ante > MAX_BLIND) {
    throw new Error(`ante must be an integer between 0 and ${MAX_BLIND}`);
  }
  if (
    !Number.isInteger(level.durationMinutes) ||
    level.durationMinutes < MIN_LEVEL_DURATION_MINUTES ||
    level.durationMinutes > MAX_LEVEL_DURATION_MINUTES
  ) {
    throw new Error(`durationMinutes must be an integer between ${MIN_LEVEL_DURATION_MINUTES} and ${MAX_LEVEL_DURATION_MINUTES}`);
  }

  return {
    smallBlind: level.smallBlind,
    bigBlind: level.bigBlind,
    ante: level.ante,
    durationMinutes: level.durationMinutes,
  };
}

function normalizeBlindLevels(levels: BlindLevelConfig[]): BlindLevelConfig[] {
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new Error("blindLevels must contain at least one level");
  }

  return levels.map(normalizeBlindLevel);
}

function getBlindLevel(levels: BlindLevelConfig[], index: number): BlindLevelConfig {
  const level = levels[index];
  if (!level) {
    throw new Error(`Blind level not found at index ${index}`);
  }

  return level;
}

interface ActionApplyResult {
  table: TableState;
  result: string;
  appliedActionType: ActionType;
  amount?: number;
}

export interface TimeoutActionResult extends ActionApplyResult {
  tableId: string;
  userId: string;
}

function getHandPlayers(players: PlayerState[]): PlayerState[] {
  return players.filter((player) => player.holeCards.length === 2);
}

function getActiveHandPlayers(players: PlayerState[]): PlayerState[] {
  return getHandPlayers(players).filter((player) => !player.isFolded);
}

function getActivePlayersCanAct(players: PlayerState[]): PlayerState[] {
  return getActiveHandPlayers(players).filter((player) => player.stack > 0);
}

function findNextSeatNoInCandidates(candidates: PlayerState[], fromSeatNo: number): number | null {
  const sorted = candidates.slice().sort((a, b) => a.seatNo - b.seatNo);
  if (sorted.length === 0) {
    return null;
  }

  const next = sorted.find((player) => player.seatNo > fromSeatNo);
  return next ? next.seatNo : sorted[0].seatNo;
}

function findNextTurnSeat(players: PlayerState[], fromSeatNo: number): number | null {
  return findNextSeatNoInCandidates(getActivePlayersCanAct(players), fromSeatNo);
}

function resolveNextButtonSeat(readyPlayers: PlayerState[], previousButtonSeatNo: number | null): number {
  const sorted = readyPlayers.slice().sort((a, b) => a.seatNo - b.seatNo);
  if (sorted.length === 0) {
    throw new Error("No ready players for button selection");
  }

  if (previousButtonSeatNo === null) {
    return sorted[0].seatNo;
  }

  const next = sorted.find((player) => player.seatNo > previousButtonSeatNo);
  return next ? next.seatNo : sorted[0].seatNo;
}

function resetRoundActionFlags(players: PlayerState[]): void {
  for (const player of players) {
    if (!player.isFolded && player.stack > 0) {
      player.hasActedThisRound = false;
    }
  }
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

function computeSidePots(players: PlayerState[], deadMoney: number = 0): SidePot[] {
  const handPlayers = getHandPlayers(players).filter((player) => player.totalContribution > 0);
  if (handPlayers.length === 0) {
    if (deadMoney <= 0) {
      return [];
    }

    const eligibleSeatNos = getActiveHandPlayers(players)
      .map((player) => player.seatNo)
      .sort((a, b) => a - b);

    return eligibleSeatNos.length > 0 ? [{ amount: deadMoney, eligibleSeatNos }] : [];
  }

  const levels = Array.from(new Set(handPlayers.map((player) => player.totalContribution))).sort(
    (a, b) => a - b
  );

  const sidePots: SidePot[] = [];
  let previousLevel = 0;

  for (const level of levels) {
    const contributors = handPlayers.filter((player) => player.totalContribution >= level);
    const amount = (level - previousLevel) * contributors.length;
    if (amount <= 0) {
      previousLevel = level;
      continue;
    }

    const eligibleSeatNos = contributors
      .filter((player) => !player.isFolded)
      .map((player) => player.seatNo)
      .sort((a, b) => a - b);

    sidePots.push({ amount, eligibleSeatNos });
    previousLevel = level;
  }

  if (deadMoney > 0) {
    sidePots[0].amount += deadMoney;
  }

  return sidePots;
}

export class TableManager {
  private readonly tables = new Map<string, TableState>();

  constructor() {
    const defaultBlindLevels = normalizeBlindLevels([
      { smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 5 },
    ]);

    this.tables.set("default", {
      tableId: "default",
      maxPlayers: 6,
      smallBlind: defaultBlindLevels[0].smallBlind,
      bigBlind: defaultBlindLevels[0].bigBlind,
      blindLevels: cloneBlindLevels(defaultBlindLevels),
      pendingBlindLevels: cloneBlindLevels(defaultBlindLevels),
      blindLevelIndex: 0,
      blindLevelStartedAt: null,
      blindLevelEndsAt: null,
      buttonSeatNo: null,
      hostUserId: null,
      actionTimeoutMs: 12000,
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
      if (!table.hostUserId) {
        table.hostUserId = userId;
      }
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
      totalContribution: 0,
      holeCards: [],
    });

    table.players.sort((a, b) => a.seatNo - b.seatNo);
    if (!table.hostUserId) {
      table.hostUserId = userId;
    }
    return table;
  }

  leave(tableId: string, userId: string): TableState {
    const table = this.getTable(tableId);
    table.players = table.players.filter((p) => p.userId !== userId);
    if (table.hostUserId === userId) {
      table.hostUserId = table.players[0]?.userId ?? null;
    }

    if (table.players.filter((p) => p.stack > 0).length < MIN_PLAYERS_TO_START_HAND) {
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

    return table;
  }

  startHandByHost(tableId: string, userId: string): TableState {
    const table = this.getTable(tableId);
    this.assertHost(table, userId);

    if (table.hand) {
      throw new Error("Hand is already active");
    }

    this.startHand(table);
    return table;
  }

  updateTableSettings(
    tableId: string,
    userId: string,
    settings: { actionTimeoutMs?: number; blindLevels?: BlindLevelConfig[] }
  ): TableState {
    const table = this.getTable(tableId);
    this.assertHost(table, userId);

    if (settings.actionTimeoutMs !== undefined) {
      const actionTimeoutMs = settings.actionTimeoutMs;
      if (!Number.isInteger(actionTimeoutMs) || actionTimeoutMs < MIN_TIMEOUT_MS || actionTimeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`actionTimeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
      }

      table.actionTimeoutMs = actionTimeoutMs;
      if (table.hand) {
        table.hand.actionTimeoutMs = actionTimeoutMs;
        table.hand.actionDeadlineAt = table.hand.currentTurnSeatNo === null ? null : Date.now() + actionTimeoutMs;
      }
    }

    if (settings.blindLevels !== undefined) {
      const normalized = normalizeBlindLevels(settings.blindLevels);
      table.pendingBlindLevels = cloneBlindLevels(normalized);
      if (!table.hand) {
        table.blindLevels = cloneBlindLevels(normalized);
        table.blindLevelIndex = 0;
        table.blindLevelStartedAt = null;
        table.blindLevelEndsAt = null;
        this.applyBlindLevelToTable(table, 0, Date.now());
      }
    }

    return table;
  }

  transferHost(tableId: string, userId: string, targetUserId: string): TableState {
    const table = this.getTable(tableId);
    this.assertHost(table, userId);

    const target = table.players.find((player) => player.userId === targetUserId);
    if (!target) {
      throw new Error("Target player not found");
    }

    table.hostUserId = targetUserId;
    return table;
  }

  applyAction(tableId: string, userId: string, action: HandActionInput): ActionApplyResult {
    const table = this.getTable(tableId);
    return this.applyActionInternal(table, userId, action);
  }

  processTimeoutActions(nowMs: number): TimeoutActionResult[] {
    const results: TimeoutActionResult[] = [];

    this.advanceBlindLevels(nowMs);

    for (const table of this.tables.values()) {
      const hand = table.hand;
      if (!hand || hand.currentTurnSeatNo === null || hand.actionDeadlineAt === null) {
        continue;
      }
      if (hand.actionDeadlineAt > nowMs) {
        continue;
      }

      const actor = table.players.find((player) => player.seatNo === hand.currentTurnSeatNo);
      if (!actor) {
        this.setTurnWithDeadline(table, null);
        continue;
      }

      const toCall = Math.max(0, hand.currentBet - actor.contribution);
      const timeoutActionType: AutoActionType = toCall === 0 ? "timeout_check" : "timeout_fold";
      const result = this.applyTimeoutAction(table, actor.userId, timeoutActionType);
      results.push({
        tableId: table.tableId,
        userId: actor.userId,
        ...result,
      });
    }

    return results;
  }

  getPublicTableState(tableId: string): PublicTableState {
    const table = this.getTable(tableId);
    return {
      tableId: table.tableId,
      maxPlayers: table.maxPlayers,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      blindLevels: cloneBlindLevels(table.blindLevels),
      pendingBlindLevels: cloneBlindLevels(table.pendingBlindLevels),
      blindLevelIndex: table.blindLevelIndex,
      blindLevelStartedAt: table.blindLevelStartedAt,
      blindLevelEndsAt: table.blindLevelEndsAt,
      buttonSeatNo: table.buttonSeatNo,
      hostUserId: table.hostUserId,
      players: table.players.map((p) => ({
        userId: p.userId,
        nickname: p.nickname,
        seatNo: p.seatNo,
        stack: p.stack,
        isReady: p.isReady,
        isFolded: p.isFolded,
        isHost: p.userId === table.hostUserId,
        contribution: p.contribution,
        totalContribution: p.totalContribution,
        holeCardsCount: p.holeCards.length,
      })),
      hand: table.hand
        ? {
            handId: table.hand.handId,
            street: table.hand.street,
            dealerSeatNo: table.hand.dealerSeatNo,
            smallBlindSeatNo: table.hand.smallBlindSeatNo,
            bigBlindSeatNo: table.hand.bigBlindSeatNo,
            blindLevelIndex: table.hand.blindLevelIndex,
            smallBlind: table.hand.smallBlind,
            bigBlind: table.hand.bigBlind,
            ante: table.hand.ante,
            communityCards: table.hand.communityCards,
            pot: table.hand.pot,
            currentBet: table.hand.currentBet,
            minRaise: table.hand.minRaise,
            sidePots: table.hand.sidePots,
            actionTimeoutMs: table.hand.actionTimeoutMs,
            actionDeadlineAt: table.hand.actionDeadlineAt,
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

  private applyTimeoutAction(
    table: TableState,
    userId: string,
    timeoutActionType: AutoActionType
  ): ActionApplyResult {
    const mappedAction: HandActionInput = {
      actionType: timeoutActionType === "timeout_check" ? "check" : "fold",
    };

    const result = this.applyActionInternal(table, userId, mappedAction);
    return {
      ...result,
      appliedActionType: timeoutActionType,
    };
  }

  private applyActionInternal(
    table: TableState,
    userId: string,
    action: HandActionInput
  ): ActionApplyResult {
    if (
      !table.hand ||
      table.hand.street === "waiting" ||
      table.hand.street === "showdown"
    ) {
      throw new Error("No active hand");
    }

    const hand = table.hand;
    const actor = table.players.find((p) => p.userId === userId);
    if (!actor) {
      throw new Error("Player not found");
    }

    if (actor.holeCards.length !== 2) {
      throw new Error("Player is not participating in this hand");
    }

    if (hand.currentTurnSeatNo !== actor.seatNo) {
      throw new Error("Not your turn");
    }

    if (actor.isFolded) {
      throw new Error("Folded player cannot act");
    }

    const toCall = Math.max(0, hand.currentBet - actor.contribution);
    const actionType = action.actionType;

    if (actionType === "fold") {
      actor.isFolded = true;
      actor.hasActedThisRound = true;
    } else if (actionType === "check") {
      if (toCall > 0) {
        throw new Error("Cannot check when facing a bet");
      }
      actor.hasActedThisRound = true;
    } else if (actionType === "call") {
      const paid = this.postWager(table, actor, toCall);
      if (toCall > 0 && paid === 0) {
        throw new Error("Cannot call with zero stack");
      }
      actor.hasActedThisRound = true;
    } else if (actionType === "raise") {
      if (!Number.isInteger(action.amount)) {
        throw new Error("Raise requires integer amount");
      }

      const targetContribution = Number(action.amount);
      if (targetContribution <= hand.currentBet) {
        throw new Error("Raise amount must be above current bet");
      }

      const minAllowed = hand.currentBet + hand.minRaise;
      if (targetContribution < minAllowed) {
        throw new Error(`Minimum raise target is ${minAllowed}`);
      }

      const needToPut = targetContribution - actor.contribution;
      if (needToPut > actor.stack) {
        throw new Error("Insufficient stack to raise");
      }

      const paid = this.postWager(table, actor, needToPut);
      if (paid !== needToPut) {
        throw new Error("Failed to post full raise amount");
      }

      const raiseSize = targetContribution - hand.currentBet;
      hand.currentBet = targetContribution;
      hand.minRaise = raiseSize;

      resetRoundActionFlags(getActiveHandPlayers(table.players));
      actor.hasActedThisRound = true;
    } else {
      throw new Error("Unsupported action");
    }

    hand.sidePots = computeSidePots(table.players, hand.ante);

    const activePlayers = getActiveHandPlayers(table.players);
    if (activePlayers.length === 1) {
      const winner = activePlayers[0];
      winner.stack += hand.pot;
      const result = `${winner.nickname} wins by fold`;
      this.finishHand(table);
      return { table, result, appliedActionType: actionType, amount: action.amount };
    }

    if (this.isRoundComplete(table)) {
      const completionResult = this.completeRoundOrHand(table);
      return {
        table,
        result: completionResult,
        appliedActionType: actionType,
        amount: action.amount,
      };
    }

    const nextSeat = findNextTurnSeat(table.players, actor.seatNo);
    this.setTurnWithDeadline(table, nextSeat);

    return { table, result: "action applied", appliedActionType: actionType, amount: action.amount };
  }

  private completeRoundOrHand(table: TableState): string {
    while (table.hand) {
      const advanced = this.advanceStreet(table);
      if (!advanced) {
        this.finishHandWithoutJudging(table, getActiveHandPlayers(table.players));
        return "hand finished without showdown judging";
      }

      if (table.hand.currentTurnSeatNo !== null) {
        return `street advanced to ${table.hand.street}`;
      }
    }

    return "hand finished";
  }

  private isRoundComplete(table: TableState): boolean {
    if (!table.hand) {
      return true;
    }

    const activePlayers = getActiveHandPlayers(table.players);
    if (activePlayers.length <= 1) {
      return true;
    }

    const everyoneMatchedOrAllIn = activePlayers.every(
      (player) => player.contribution === table.hand!.currentBet || player.stack === 0
    );
    const everyoneActedOrAllIn = activePlayers.every(
      (player) => player.hasActedThisRound || player.stack === 0
    );

    return everyoneMatchedOrAllIn && everyoneActedOrAllIn;
  }

  private getTable(tableId: string): TableState {
    const table = this.tables.get(tableId);
    if (!table) {
      throw new Error(`Table not found: ${tableId}`);
    }
    return table;
  }

  private assertHost(table: TableState, userId: string): void {
    if (table.hostUserId !== userId) {
      throw new Error("Only the host can perform this action");
    }
  }

  private startHand(table: TableState): void {
    const activePlayers = table.players.filter((player) => player.stack > 0).sort((a, b) => a.seatNo - b.seatNo);
    if (activePlayers.length < MIN_PLAYERS_TO_START_HAND) {
      return;
    }

    this.applyPendingBlindLevels(table);
    this.advanceBlindLevels(Date.now(), table);
    const activeBlindLevel = getBlindLevel(table.blindLevels, table.blindLevelIndex);
    table.smallBlind = activeBlindLevel.smallBlind;
    table.bigBlind = activeBlindLevel.bigBlind;

    const dealerSeatNo = resolveNextButtonSeat(activePlayers, table.buttonSeatNo);
    table.buttonSeatNo = dealerSeatNo;

    const deck = shuffleDeck(createDeck());

    for (const player of table.players) {
      player.isFolded = false;
      player.hasActedThisRound = false;
      player.contribution = 0;
      player.totalContribution = 0;
      player.holeCards = [];

      if (player.stack > 0) {
        const first = deck.shift();
        const second = deck.shift();
        if (!first || !second) {
          throw new Error("Deck underflow while dealing cards");
        }
        player.holeCards = [first, second];
      }
    }

    const smallBlindSeatNo =
      activePlayers.length === 2
        ? dealerSeatNo
        : findNextSeatNoInCandidates(activePlayers, dealerSeatNo);
    if (smallBlindSeatNo === null) {
      throw new Error("Cannot determine small blind seat");
    }

    const bigBlindSeatNo = findNextSeatNoInCandidates(activePlayers, smallBlindSeatNo);
    if (bigBlindSeatNo === null) {
      throw new Error("Cannot determine big blind seat");
    }

    const smallBlindPlayer = activePlayers.find((player) => player.seatNo === smallBlindSeatNo);
    const bigBlindPlayer = activePlayers.find((player) => player.seatNo === bigBlindSeatNo);
    if (!smallBlindPlayer || !bigBlindPlayer) {
      throw new Error("Blind player not found");
    }

    const hand: HandState = {
      handId: uuidv4(),
      street: "preflop",
      dealerSeatNo,
      smallBlindSeatNo,
      bigBlindSeatNo,
      blindLevelIndex: table.blindLevelIndex,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      ante: activeBlindLevel.ante,
      deck,
      communityCards: [],
      pot: 0,
      currentBet: 0,
      minRaise: table.bigBlind,
      sidePots: [],
      actionTimeoutMs: table.actionTimeoutMs,
      actionDeadlineAt: null,
      currentTurnSeatNo: null,
    };

    table.hand = hand;

    if (hand.ante > 0) {
      this.postBlindAnte(table, bigBlindPlayer, hand.ante);
    }

    const postedSb = this.postWager(table, smallBlindPlayer, table.smallBlind);
    const postedBb = this.postWager(table, bigBlindPlayer, table.bigBlind);

    hand.currentBet = Math.max(postedSb, postedBb);
    hand.sidePots = computeSidePots(table.players, hand.ante);

    const preflopFromSeatNo = activePlayers.length === 2 ? dealerSeatNo : bigBlindSeatNo;
    const firstTurnSeatNo = findNextTurnSeat(table.players, preflopFromSeatNo);
    this.setTurnWithDeadline(table, firstTurnSeatNo);
  }

  private postWager(table: TableState, player: PlayerState, amount: number): number {
    if (!table.hand || amount <= 0) {
      return 0;
    }

    const paid = Math.min(amount, player.stack);
    if (paid <= 0) {
      return 0;
    }

    player.stack -= paid;
    player.contribution += paid;
    player.totalContribution += paid;
    table.hand.pot += paid;

    return paid;
  }

  private postBlindAnte(table: TableState, player: PlayerState, amount: number): number {
    if (!table.hand || amount <= 0) {
      return 0;
    }

    const paid = Math.min(amount, player.stack);
    if (paid <= 0) {
      return 0;
    }

    player.stack -= paid;
    table.hand.pot += paid;

    return paid;
  }

  private setTurnWithDeadline(table: TableState, seatNo: number | null): void {
    if (!table.hand) {
      return;
    }

    table.hand.currentTurnSeatNo = seatNo;
    table.hand.actionDeadlineAt = seatNo === null ? null : Date.now() + table.hand.actionTimeoutMs;
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
    table.hand.minRaise = table.bigBlind;

    for (const player of getHandPlayers(table.players)) {
      player.contribution = 0;
    }

    resetRoundActionFlags(getHandPlayers(table.players));

    const firstTurnSeatNo = findNextTurnSeat(table.players, table.hand.dealerSeatNo);
    this.setTurnWithDeadline(table, firstTurnSeatNo ?? null);

    table.hand.sidePots = computeSidePots(table.players, table.hand.ante);
    return true;
  }

  private finishHandWithoutJudging(table: TableState, activePlayers: PlayerState[]): void {
    if (table.hand && activePlayers.length > 0) {
      const sidePots = table.hand.sidePots;
      if (sidePots.length === 0) {
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
      } else {
        for (const sidePot of sidePots) {
          const eligible = activePlayers
            .filter((player) => sidePot.eligibleSeatNos.includes(player.seatNo))
            .sort((a, b) => a.seatNo - b.seatNo);

          if (eligible.length === 0) {
            continue;
          }

          const share = Math.floor(sidePot.amount / eligible.length);
          const remainder = sidePot.amount % eligible.length;

          for (const player of eligible) {
            player.stack += share;
          }

          if (remainder > 0) {
            eligible[0].stack += remainder;
          }
        }
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
      player.totalContribution = 0;
      player.holeCards = [];
    }

    if (table.players.filter((player) => player.stack > 0).length >= MIN_PLAYERS_TO_START_HAND) {
      this.startHand(table);
    }
  }

  private applyPendingBlindLevels(table: TableState): void {
    table.blindLevels = cloneBlindLevels(table.pendingBlindLevels);
  }

  private advanceBlindLevels(nowMs: number, table?: TableState): void {
    const tables = table ? [table] : Array.from(this.tables.values());

    for (const currentTable of tables) {
      if (currentTable.blindLevels.length === 0) {
        continue;
      }

      if (currentTable.blindLevelStartedAt === null || currentTable.blindLevelEndsAt === null) {
        this.applyBlindLevelToTable(currentTable, currentTable.blindLevelIndex, nowMs);
        continue;
      }

      while (
        currentTable.blindLevelEndsAt !== null &&
        nowMs >= currentTable.blindLevelEndsAt &&
        currentTable.blindLevelIndex < currentTable.blindLevels.length - 1
      ) {
        this.applyBlindLevelToTable(currentTable, currentTable.blindLevelIndex + 1, currentTable.blindLevelEndsAt);
      }

      if (
        currentTable.blindLevelEndsAt !== null &&
        nowMs >= currentTable.blindLevelEndsAt &&
        currentTable.blindLevelIndex === currentTable.blindLevels.length - 1
      ) {
        currentTable.blindLevelEndsAt = null;
      }
    }
  }

  private applyBlindLevelToTable(table: TableState, blindLevelIndex: number, nowMs: number): void {
    const blindLevel = getBlindLevel(table.blindLevels, blindLevelIndex);
    table.blindLevelIndex = blindLevelIndex;
    table.smallBlind = blindLevel.smallBlind;
    table.bigBlind = blindLevel.bigBlind;
    table.blindLevelStartedAt = nowMs;
    table.blindLevelEndsAt = blindLevel.durationMinutes > 0 ? nowMs + blindLevel.durationMinutes * 60 * 1000 : null;
  }
}
