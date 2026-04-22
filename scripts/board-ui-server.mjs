/**
 * Lekki serwer tylko z podglądem /board — czyta snapshot z dysku.
 * Główna aplikacja (index.js) musi mieć BOARD_SNAPSHOT_SYNC=1, żeby plik był aktualizowany.
 * Restart tego procesu nie dotyka Messengera ani e-Remiza.
 */
import path from "node:path";
import fs from "node:fs/promises";
import express from "express";
import dotenv from "dotenv";
import {
  boardJsonHrefWithDemo,
  boardAuthMiddleware,
  boardSnapshotPath,
  isDemoQuery,
  loadDemoBoardPayload,
  mergeArrivedNamesIntoPayload,
  renderBoardPage,
  toggleArrivalForData,
  buildRemizaPayloadForData,
  remizaSetHeadcountChoice,
  remizaToggleRoleManual,
} from "../board.js";

dotenv.config({ path: path.join(process.cwd(), ".env") });

const port = Number(process.env.BOARD_UI_PORT) || 9997;
const bindHost = process.env.BIND_HOST?.trim() || "0.0.0.0";

async function loadBoardData(req) {
  const emptyPayload = () => ({
    generatedAt: null,
    lastIngestAt: null,
    activeAlarm: null,
    reactionsByOption: {},
    chatMessages: [],
  });
  try {
    const raw = await fs.readFile(boardSnapshotPath(), "utf8");
    let data = JSON.parse(raw);
    if (isDemoQuery(req)) {
      const demo = loadDemoBoardPayload();
      if (demo) data = demo;
    }
    return mergeArrivedNamesIntoPayload(data);
  } catch {
    let data = emptyPayload();
    if (isDemoQuery(req)) {
      const demo = loadDemoBoardPayload();
      if (demo) data = demo;
    }
    return mergeArrivedNamesIntoPayload(data);
  }
}

const app = express();
app.use(express.json({ limit: "64kb" }));

const jsonHandler = async (req, res) => {
  const data = await loadBoardData(req);
  res.json(data);
};

const htmlHandler = async (req, res) => {
  if (req.query.format === "json") {
    const data = await loadBoardData(req);
    res.json(data);
    return;
  }
  const data = await loadBoardData(req);
  const secQ = req.query.secret
    ? `?secret=${encodeURIComponent(String(req.query.secret))}`
    : "";
  const jsonHref = boardJsonHrefWithDemo("/board", secQ, req);
  res.status(200).type("html").send(renderBoardPage(data, jsonHref, req));
};

const arrivalToggleHandler = async (req, res) => {
  const name =
    typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ ok: false, error: "Brak pola name" });
    return;
  }
  try {
    const data = await loadBoardData(req);
    const arrivedNames = toggleArrivalForData(name, data);
    const remiza = buildRemizaPayloadForData({ ...data, arrivedNames });
    res.json({ ok: true, arrivedNames, remiza });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e?.message ? String(e.message) : String(e) });
  }
};

const remizaMutationHandler = async (req, res) => {
  const op = req.body?.op;
  try {
    const data = await loadBoardData(req);
    if (op === "headcount") {
      const v = Number(req.body?.value);
      if (!Number.isFinite(v) || v < 1 || v > 6 || Math.floor(v) !== v) {
        res.status(400).json({ ok: false, error: "value: oczekiwano liczby całkowitej 1–6" });
        return;
      }
      const remiza = remizaSetHeadcountChoice(data, v);
      res.json({ ok: true, remiza });
      return;
    }
    if (op === "role") {
      const role = req.body?.role;
      if (role !== "dowodca" && role !== "kierowca") {
        res.status(400).json({ ok: false, error: "role: dowodca | kierowca" });
        return;
      }
      const remiza = remizaToggleRoleManual(data, role);
      res.json({ ok: true, remiza });
      return;
    }
    res.status(400).json({ ok: false, error: "Nieznane op (headcount z value 1–6 | role)" });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e?.message ? String(e.message) : String(e) });
  }
};

for (const p of ["/board.json", "/board.json/"]) {
  app.get(p, boardAuthMiddleware, jsonHandler);
}
for (const p of ["/board", "/board/"]) {
  app.get(p, boardAuthMiddleware, htmlHandler);
}
for (const p of ["/board/arrival/toggle", "/board/arrival/toggle/"]) {
  app.post(p, boardAuthMiddleware, arrivalToggleHandler);
}
for (const p of ["/board/remiza", "/board/remiza/"]) {
  app.post(p, boardAuthMiddleware, remizaMutationHandler);
}

app.listen(port, bindHost, () => {
  console.log(
    `[board:ui] http://127.0.0.1:${port}/board (tablet w LAN: http://<IP>:${port}/board) — snapshot: ${boardSnapshotPath()}`,
  );
  console.log(
    "[board:ui] Upewnij się, że główny serwer ma BOARD_SNAPSHOT_SYNC=1 (ten proces tylko czyta plik).",
  );
  console.log(
    "[board:ui] Stan przybyć: board-arrivals.json · licznik remiza: board-remiza-state.json (współdzielone z głównym serwerem przy tym samym dysku).",
  );
});
