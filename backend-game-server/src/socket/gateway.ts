import { Server } from "http";
import { Server as SocketIOServer } from "socket.io";
import { TableManager } from "../game/state";
import { HandActionInput } from "../game/types";
import { AuthenticatedSocket } from "./types";

interface InitGatewayInput {
  httpServer: Server;
  corsOrigin: string;
  tableManager: TableManager;
}

export function initGateway({ httpServer, corsOrigin, tableManager }: InitGatewayInput): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOrigin,
      methods: ["GET", "POST"],
    },
  });

  io.use((socket: AuthenticatedSocket, next) => {
    const userId = String(socket.handshake.auth.userId ?? "").trim();
    const nickname = String(socket.handshake.auth.nickname ?? "").trim();

    if (!userId || !nickname) {
      next(new Error("Missing auth.userId or auth.nickname"));
      return;
    }

    socket.data.userId = userId;
    socket.data.nickname = nickname;
    next();
  });

  io.on("connection", (socket: AuthenticatedSocket) => {
    socket.emit("system:connected", { socketId: socket.id });

    socket.on("table:join", ({ tableId }: { tableId: string }) => {
      try {
        const joined = tableManager.join(tableId, socket.data.userId, socket.data.nickname, socket.id);
        socket.data.tableId = tableId;
        socket.join(tableId);

        io.to(tableId).emit("table:state", tableManager.getPublicTableState(joined.tableId));

        const privateState = tableManager.getPrivateState(tableId, socket.data.userId);
        socket.emit("player:private", privateState);
      } catch (error) {
        socket.emit("error:event", {
          code: "JOIN_FAILED",
          message: error instanceof Error ? error.message : "Unknown join error",
        });
      }
    });

    socket.on("player:ready", () => {
      if (!socket.data.tableId) {
        socket.emit("error:event", { code: "NO_TABLE", message: "Join a table first" });
        return;
      }

      try {
        const table = tableManager.markReady(socket.data.tableId, socket.data.userId);
        io.to(socket.data.tableId).emit("table:state", tableManager.getPublicTableState(table.tableId));

        for (const player of table.players) {
          const privateState = tableManager.getPrivateState(table.tableId, player.userId);
          if (!privateState) {
            continue;
          }

          io.to(player.socketId).emit("player:private", privateState);
        }
      } catch (error) {
        socket.emit("error:event", {
          code: "READY_FAILED",
          message: error instanceof Error ? error.message : "Unknown ready error",
        });
      }
    });

    socket.on("hand:action", (payload: HandActionInput) => {
      if (!socket.data.tableId) {
        socket.emit("error:event", { code: "NO_TABLE", message: "Join a table first" });
        return;
      }

      try {
        const { table, result, appliedActionType, amount } = tableManager.applyAction(
          socket.data.tableId,
          socket.data.userId,
          payload
        );

        io.to(socket.data.tableId).emit("hand:action_applied", {
          userId: socket.data.userId,
          actionType: appliedActionType,
          amount,
          result,
        });
        io.to(socket.data.tableId).emit("table:state", tableManager.getPublicTableState(table.tableId));

        for (const player of table.players) {
          const privateState = tableManager.getPrivateState(table.tableId, player.userId);
          io.to(player.socketId).emit("player:private", privateState);
        }
      } catch (error) {
        socket.emit("error:event", {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "Unknown action error",
        });
      }
    });

    socket.on("table:leave", () => {
      if (!socket.data.tableId) {
        return;
      }

      const tableId = socket.data.tableId;
      try {
        const table = tableManager.leave(tableId, socket.data.userId);
        socket.leave(tableId);
        socket.data.tableId = undefined;
        io.to(tableId).emit("table:state", tableManager.getPublicTableState(table.tableId));
      } catch {
        // ignore leave failures on disconnect flow
      }
    });

    socket.on("disconnect", () => {
      if (!socket.data.tableId) {
        return;
      }

      try {
        const table = tableManager.leave(socket.data.tableId, socket.data.userId);
        io.to(table.tableId).emit("table:state", tableManager.getPublicTableState(table.tableId));
      } catch {
        // ignore disconnect cleanup failures
      }
    });
  });

  setInterval(() => {
    const timeoutResults = tableManager.processTimeoutActions(Date.now());
    for (const timeoutResult of timeoutResults) {
      const { tableId, userId, appliedActionType, amount, result, table } = timeoutResult;

      io.to(tableId).emit("hand:action_applied", {
        userId,
        actionType: appliedActionType,
        amount,
        result,
      });
      io.to(tableId).emit("table:state", tableManager.getPublicTableState(table.tableId));

      for (const player of table.players) {
        const privateState = tableManager.getPrivateState(table.tableId, player.userId);
        io.to(player.socketId).emit("player:private", privateState);
      }
    }
  }, 300);

  return io;
}
