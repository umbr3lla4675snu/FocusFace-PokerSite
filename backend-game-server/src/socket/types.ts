import { Socket } from "socket.io";

export interface AuthenticatedSocket extends Socket {
  data: Socket["data"] & {
    userId: string;
    nickname: string;
    tableId?: string;
  };
}
