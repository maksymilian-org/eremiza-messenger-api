import http from "node:http";
import express from "express";
import dotenv from "dotenv";
import { validate } from "./validate.js";
import {
  getLastAlert,
  keepAliveEremizaTick,
  pollEremizaForNewAlert,
  warmupERemiza,
} from "./eremiza.js";
import { Messenger } from "./messenger.js";
import { getData, getIsChecking, setAlertData, setIsChecking } from "./gist.js";
import { waitForTimeout } from "./utils.js";

dotenv.config();
validate();

const app = express();
const port = Number(process.env.PORT) || 9998;

/** Jedna instancja + profil Chromium — logowanie przy starcie, przy alarmie tylko szybkie sprawdzenie. */
const sharedMessenger = new Messenger();

/** Po treści alarmu — prośba o reakcję + legenda (emoji zbliżone do kolorów reakcji w Messengerze). */
const MESSENGER_REACTION_FOLLOWUPS = [
  "❌ Nie jadę",
  "✅ Będę za 1-3 min",
  "⚠ Będę za 4-6 min",
  "☑ Mogę być powyżej 7 min",
  "‼ Dojadę sam, weźcie nomex",
];

const launch = async () => {
  console.time("Message");
  try {
    const ITERATION_OF_CHECKING = Number(process.env.ITERATION_OF_CHECKING) || 6;
    const WAIT_BETWEEN_CHECKING =
      Number(process.env.WAIT_BETWEEN_CHECKING) || 15000;
    const messenger = sharedMessenger;

    const isChecking = await getIsChecking();
    if (isChecking) {
      console.log("Already checking. Give up sending messages");
      return { ok: true, outcome: "skipped_already_checking" };
    }

    for (let i = 0; i < ITERATION_OF_CHECKING; i++) {
      console.log("Iteration", i + 1, "of checking");
      const [lastEremizaAlert, lastGistAlert] = await Promise.all([
        getLastAlert(),
        getData(),
        setIsChecking(true),
        messenger.launchBrowser(),
      ]);

      if (!lastEremizaAlert?.date) {
        await setIsChecking(false);
        return {
          ok: false,
          error:
            "Nie udało się pobrać ostatniego alarmu z e-Remiza (sprawdź logi serwera).",
          stage: "e_remiza",
        };
      }

      let eremizaAlert = lastEremizaAlert;

      if (eremizaAlert.date === lastGistAlert?.date && lastGistAlert?.date) {
        const polled = await pollEremizaForNewAlert(lastGistAlert.date);
        if (polled) {
          eremizaAlert = polled;
        }
      }

      if (eremizaAlert.date === lastGistAlert?.date) {
        console.log(
          "Nothing new on e-Remiza alerts list. Waiting for the next iteration of checking..."
        );
        if (i + 1 !== ITERATION_OF_CHECKING) {
          await waitForTimeout(WAIT_BETWEEN_CHECKING);
        }
        continue;
      }

      const directionsLink = `https://www.google.com/maps/dir/?api=1&origin=${process.env.FIRE_BRIGADE_COORDINATES}&destination=${eremizaAlert.coords}&travelmode=driving&layer=traffic`;
      const message = `🚨 ${eremizaAlert.type}, ${eremizaAlert.address}, ${eremizaAlert.description} ${directionsLink}\n\nDodaj reakcję ❤ (podwójny klik):`;

      console.log("Sending messages about new alert...");
      await messenger.sendMessages([
        { type: "text", value: message },
        ...MESSENGER_REACTION_FOLLOWUPS.map((value) => ({ type: "text", value })),
        // { type: "map", value: eremizaAlert.coords },
      ]);
      console.log("Saving new alert...");
      await setAlertData(eremizaAlert);

      await setIsChecking(false);
      console.log("Checking finnished");
      return { ok: true, outcome: "sent" };
    }

    await setIsChecking(false);
    console.log("Checking finnished");
    return { ok: true, outcome: "no_new_alert" };
  } catch (err) {
    await setIsChecking(false);
    console.error(err);
    return {
      ok: false,
      error: err?.message ?? String(err),
      stack: err?.stack,
      stage: "launch",
    };
  } finally {
    console.timeEnd("Message");
  }
};
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/alert", async (req, res) => {
  console.log("Start alert checking");
  try {
    const result = await launch();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err?.message ?? String(err),
      stack: err?.stack,
      stage: "handler",
    });
  }
});

app.get("/heartbeat", (req, res) => {
  console.log("Heartbeat received");
  res.status(200).send("OK");
});

/** Cichy ping wewnętrzny (bez logów) — utrzymanie HTTP i timera Node przy długiej bezczynności. */
app.get("/__keepalive", (_req, res) => {
  res.status(204).end();
});

app.listen(port, () => {
  console.log(`Website-checker is listening on port ${port}.`);

  const rawKeepalive = process.env.SERVER_KEEPALIVE_INTERVAL_MS?.trim();
  const keepaliveMs =
    rawKeepalive === "" || rawKeepalive === undefined
      ? 5 * 60 * 1000
      : Number(rawKeepalive);
  if (Number.isFinite(keepaliveMs) && keepaliveMs > 0) {
    setInterval(() => {
      http
        .get(`http://127.0.0.1:${port}/__keepalive`, (r) => r.resume())
        .on("error", () => {});
      void sharedMessenger.keepAliveTick();
      void keepAliveEremizaTick();
    }, keepaliveMs);
    console.log(
      `Keep-alive: co ${Math.round(keepaliveMs / 1000)}s (HTTP + Chromium Messenger/e-Remiza). Wyłącz: SERVER_KEEPALIVE_INTERVAL_MS=0`
    );
  }

  sharedMessenger
    .warmup()
    .then(() => console.log("Messenger: rozgrzewka zakończona (sesja gotowa)."))
    .catch((err) =>
      console.error("Messenger: rozgrzewka nie powiodła się:", err?.message || err)
    );
  warmupERemiza()
    .then(() =>
      console.log("e-Remiza: rozgrzewka zakończona (sesja w Chromium gotowa).")
    )
    .catch((err) =>
      console.error("e-Remiza: rozgrzewka nie powiodła się:", err?.message || err)
    );
});
