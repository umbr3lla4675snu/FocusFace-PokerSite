import cors from "cors";
import express from "express";
import { createServer } from "http";
import { env } from "./config/env";
import { TableManager } from "./game/state";
import { initGateway } from "./socket/gateway";

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: env.corsOrigin,
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "game-server" });
});

const httpServer = createServer(app);
const tableManager = new TableManager();
initGateway({
  httpServer,
  corsOrigin: env.corsOrigin,
  tableManager,
});

httpServer.listen(env.port, () => {
  console.log(`[game-server] listening on :${env.port}`);
});
