import "./logger.js";
import http from "node:http";
import express from "express";
import dotenv from "dotenv";
import { validate } from "./validate.js";
import {
  getLastAlert,
  isApibetaDisabled,
  isSameEremizaAsGist,
  keepAliveEremizaTick,
  pollEremizaForNewAlert,
  useApibetaEremiza,
  warmupERemiza,
} from "./eremiza.js";
import { ALARM_REACTION_FOLLOWUP_LINES } from "./alarm-followups.js";
import { Messenger } from "./messenger.js";
import { getData, getIsChecking, setAlertData, setIsChecking } from "./gist.js";
import { buildFakeAlert, isFakeAlarmEnabled } from "./fake-alarm.js";
import {
  isBoardSnapshotSyncEnabled,
  mountBoardRoutes,
  registerAlarmDispatch,
} from "./board.js";
import { waitForTimeout } from "./utils.js";
import { mountAlarmSse } from "./alarm-sse.js";

dotenv.config();
validate();

const app = express();
app.use(express.json({ limit: "64kb" }));
const port = Number(process.env.PORT) || 9998;
/** `0.0.0.0` — dostęp z tabletu / telefonu w LAN po IP komputera (np. http://192.168.1.10:9988/board). */
const bindHost = process.env.BIND_HOST?.trim() || "0.0.0.0";

/** Odstęp między pingami Automate — powyżej uznajemy Flow na telefonie za niedziałający (domyślnie 1,5 min). */
const AUTOMATE_PING_MAX_GAP_MS = (() => {
  const n = Number(process.env.AUTOMATE_PING_MAX_GAP_MS);
  return Number.isFinite(n) && n > 0 ? n : 90_000;
})();

let automateLastPingMs = null;

function getAutomateFlowStatus() {
  const now = Date.now();
  if (automateLastPingMs == null) {
    return {
      lastPingAt: null,
      ageMs: null,
      secondsSinceLastPing: null,
      ok: false,
      maxGapMs: AUTOMATE_PING_MAX_GAP_MS,
    };
  }
  const ageMs = now - automateLastPingMs;
  return {
    lastPingAt: new Date(automateLastPingMs).toISOString(),
    ageMs,
    secondsSinceLastPing: Math.round(ageMs / 1000),
    ok: ageMs <= AUTOMATE_PING_MAX_GAP_MS,
    maxGapMs: AUTOMATE_PING_MAX_GAP_MS,
  };
}

/** Jedna instancja + profil Chromium — logowanie przy starcie, przy alarmie tylko szybkie sprawdzenie. */
const sharedMessenger = new Messenger();

/** Ping własnego HTTP (jak w interwale keep-alive) — bez logów. */
function probeInternalKeepalive(targetPort) {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${targetPort}/__keepalive`,
      (res) => {
        res.resume();
        resolve(res.statusCode === 204);
      },
    );
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function eremizaKeepaliveLogPl(e) {
  return e.source === "hybrid"
    ? `e-Remiza hybryda API(sesja:${e.apiSessionOk ? "tak" : "nie"},zapytanie:${e.apiOk ? "tak" : "nie"}) | zapas Chromium(br:${e.browserOk ? "tak" : "nie"},karta:${e.pageOk ? "tak" : "nie"},JS:${e.jsOk ? "tak" : "nie"})`
    : e.source === "apibeta"
      ? `e-Remiza API sesja:${e.sessionOk ? "tak" : "nie"} zapytanie:${e.apiOk ? "tak" : "nie"}`
      : `e-Remiza chromium:${e.browserOk ? "tak" : "nie"} karta:${e.pageOk ? "tak" : "nie"} JS:${e.jsOk ? "tak" : "nie"}`;
}

/** Ten sam zestaw co log `[keep-alive]` — pod endpoint /status i monitor zewnętrzny. */
async function collectComponentStatus() {
  const httpOk = await probeInternalKeepalive(port);
  const [m, e] = await Promise.all([
    sharedMessenger.keepAliveTick(),
    keepAliveEremizaTick(),
  ]);
  const messengerReady =
    m.browserOk && m.pageOk && m.composerOk && m.jsOk;
  const eremizaReady =
    e.source === "hybrid"
      ? (e.apiSessionOk && e.apiOk) ||
        (e.browserOk && e.pageOk && e.jsOk)
      : e.source === "apibeta"
        ? e.sessionOk && e.apiOk
        : e.browserOk && e.pageOk && e.jsOk;

  const automate = getAutomateFlowStatus();

  return {
    at: new Date().toISOString(),
    service: "eremiza-messenger-api",
    eremizaMode: useApibetaEremiza()
      ? "apibeta_only"
      : isApibetaDisabled()
        ? "chromium_only"
        : "hybrid",
    http: { internalLoopbackOk: httpOk },
    messenger: { ...m, ready: messengerReady },
    eremiza: { ...e, ready: eremizaReady },
    automate,
    pipeline: {
      readyForAlarm: httpOk && messengerReady && eremizaReady,
      automateFlowOk: automate.ok,
    },
  };
}

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

      if (
        isSameEremizaAsGist(eremizaAlert, lastGistAlert) &&
        (lastGistAlert?.date != null || lastGistAlert?.incidentId != null)
      ) {
        const polled = await pollEremizaForNewAlert(lastGistAlert);
        if (polled) {
          eremizaAlert = polled;
        }
      }

      if (isSameEremizaAsGist(eremizaAlert, lastGistAlert)) {
        console.log(
          "Nothing new on e-Remiza alerts list. Waiting for the next iteration of checking..."
        );
        if (i + 1 !== ITERATION_OF_CHECKING) {
          await waitForTimeout(WAIT_BETWEEN_CHECKING);
        }
        continue;
      }

      const directionsLink = `https://www.google.com/maps/dir/?api=1&origin=${process.env.FIRE_BRIGADE_COORDINATES}&destination=${eremizaAlert.coords}&travelmode=driving&layer=traffic`;
      const message = `🚨 ${eremizaAlert.type}, ${eremizaAlert.address}, ${eremizaAlert.description} ${directionsLink} @wszyscy\n\nDodaj reakcję ❤ (podwójny klik):`;

      console.log("Sending messages about new alert...");
      await messenger.sendMessages([
        { type: "text", value: message },
        ...ALARM_REACTION_FOLLOWUP_LINES.map((value) => ({ type: "text", value })),
        // { type: "map", value: eremizaAlert.coords },
      ]);
      registerAlarmDispatch(eremizaAlert);
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

/**
 * Fałszywy alarm do testów Messengera + tablicy reakcji.
 * Wymaga ALLOW_FAKE_ALARM=1 w .env. Nie zapisuje Gista.
 * GET/POST /alert/test — opcjonalnie ?dry=1 tylko tablica HTML (bez wysyłki na Messenger).
 */
const handleFakeAlarmTest = async (req, res) => {
  if (!isFakeAlarmEnabled()) {
    res.status(404).json({
      ok: false,
      error:
        "Endpoint wyłączony. Ustaw ALLOW_FAKE_ALARM=1 w .env i zrestartuj serwer.",
    });
    return;
  }

  const dry =
    req.query.dry === "1" ||
    req.query.dry === "true" ||
    String(req.query.skip_messenger || "") === "1";

  const eremizaAlert = buildFakeAlert();
  registerAlarmDispatch(eremizaAlert);

  if (dry) {
    console.log(
      "[alert/test] dry-run — tablica reakcji ustawiona, bez wysyłki Messengera.",
    );
    res.status(200).json({
      ok: true,
      outcome: "dry_board_only",
      alert: eremizaAlert,
      hint: "Otwórz /board lub /messenger/board — bez wiadomości w czacie.",
    });
    return;
  }

  try {
    console.log("[alert/test] wysyłka fałszywego alarmu na Messenger…");
    await sharedMessenger.launchBrowser();
    const directionsLink = `https://www.google.com/maps/dir/?api=1&origin=${process.env.FIRE_BRIGADE_COORDINATES}&destination=${eremizaAlert.coords}&travelmode=driving&layer=traffic`;
    const message = `🚨 ${eremizaAlert.type}, ${eremizaAlert.address}, ${eremizaAlert.description} ${directionsLink} @wszyscy\n\nDodaj reakcję ❤ (podwójny klik):`;

    await sharedMessenger.sendMessages([
      { type: "text", value: message },
      ...ALARM_REACTION_FOLLOWUP_LINES.map((value) => ({ type: "text", value })),
    ]);

    res.status(200).json({
      ok: true,
      outcome: "sent_fake",
      alert: eremizaAlert,
      hint: "Sprawdź czat i /board — Gist nie został zmieniony.",
    });
  } catch (err) {
    console.error("[alert/test]", err);
    res.status(500).json({
      ok: false,
      error: err?.message ?? String(err),
      stack: err?.stack,
      stage: "fake_alarm",
    });
  }
};

app.get("/alert/test", handleFakeAlarmTest);
app.post("/alert/test", handleFakeAlarmTest);

app.get("/heartbeat", (req, res) => {
  console.log("Heartbeat received");
  res.status(200).send("OK");
});

/**
 * Ping z aplikacji Automate na telefonie (np. co 1 min) — utrwala czas ostatniego żądania.
 * GET lub POST; odpowiedź lekka pod task HTTP w Automate. Brak pingów dłużej niż `maxGapMs` → `automate.ok: false` w /status.
 */
const handleAutomatePing = (_req, res) => {
  automateLastPingMs = Date.now();
  res.status(200).json({
    ok: true,
    at: new Date(automateLastPingMs).toISOString(),
  });
};
app.get("/automate/ping", handleAutomatePing);
app.post("/automate/ping", handleAutomatePing);

/**
 * Status składników (HTTP w pętli, Messenger Chromium, e-Remiza) — odpowiednik logu `[keep-alive]`.
 * JSON dla zewnętrznego monitora; `pipeline.readyForAlarm` = pełna gotowość jak w logu terminala.
 */
app.get("/status", async (_req, res) => {
  try {
    const body = await collectComponentStatus();
    res.status(200).json(body);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err?.message ?? String(err),
      stack: err?.stack,
    });
  }
});

/** Cichy ping wewnętrzny (bez logów) — utrzymanie HTTP i timera Node przy długiej bezczynności. */
app.get("/__keepalive", (_req, res) => {
  res.status(204).end();
});

mountAlarmSse(app);
mountBoardRoutes(app);

app.listen(port, bindHost, () => {
  console.log(
    `Website-checker: port ${port}, interfejs ${bindHost === "0.0.0.0" ? "wszystkie (LAN)" : bindHost} — status: http://127.0.0.1:${port}/status · Automate ping: http://127.0.0.1:${port}/automate/ping`,
  );
  console.log(
    `[board] lokalnie: http://127.0.0.1:${port}/board · w domu (tablet): http://<IP-tego-komputera>:${port}/board`,
  );
  if (isBoardSnapshotSyncEnabled()) {
    const uiPort = Number(process.env.BOARD_UI_PORT) || 9997;
    console.log(
      `[board] snapshot włączony — osobny podgląd UI bez restartu Chromium: npm run board:ui → http://127.0.0.1:${uiPort}/board`,
    );
  }
  if (isFakeAlarmEnabled()) {
    console.log(
      `[alert/test] włączony: http://127.0.0.1:${port}/alert/test — fałszywy alarm (Gist bez zmian); ?dry=1 = tylko /board bez Messengera`,
    );
  }
  const sseTokenHint = process.env.ALARM_SSE_TOKEN?.trim()
    ? " (wymagany ?token= lub Authorization: Bearer …)"
    : "";
  console.log(
    `[alarm-sse] strumień: http://127.0.0.1:${port}/alerts/events${sseTokenHint} — zdarzenie "alarm" (JSON: registeredAt, alert)`,
  );
  const rawKeepalive = process.env.SERVER_KEEPALIVE_INTERVAL_MS?.trim();
  const keepaliveMs =
    rawKeepalive === "" || rawKeepalive === undefined
      ? 5 * 60 * 1000
      : Number(rawKeepalive);
  if (Number.isFinite(keepaliveMs) && keepaliveMs > 0) {
    const runKeepAliveReport = async () => {
      const s = await collectComponentStatus();
      const eremizaLog = eremizaKeepaliveLogPl(s.eremiza);
      const autoLog = s.automate.ok
        ? `OK (ostatni ping ${s.automate.secondsSinceLastPing ?? 0}s temu)`
        : s.automate.lastPingAt == null
          ? "BŁĄD (brak pingów)"
          : `BŁĄD (próg ${Math.round(s.automate.maxGapMs / 1000)}s, ostatni ping ${s.automate.secondsSinceLastPing}s temu)`;
      console.log(
        `[keep-alive] HTTP:${s.http.internalLoopbackOk ? "OK" : "BŁĄD"} | Messenger chromium:${s.messenger.browserOk ? "tak" : "nie"} strona:${s.messenger.pageOk ? "tak" : "nie"} kompozytor:${s.messenger.composerOk ? "tak" : "nie"} JS:${s.messenger.jsOk ? "tak" : "nie"} | ${eremizaLog} | Automate:${autoLog} | gotowość na alarm:${s.pipeline.readyForAlarm ? "PEŁNA" : "NIEPEŁNA"}`
      );
    };

    setInterval(() => {
      void runKeepAliveReport();
    }, keepaliveMs);

    console.log(
      `Keep-alive: co ${Math.round(keepaliveMs / 1000)}s — log statusu + ping HTTP/Chromium. Wyłącz: SERVER_KEEPALIVE_INTERVAL_MS=0`
    );
  }

  sharedMessenger
    .warmup()
    .then(() => {
      console.log("Messenger: rozgrzewka zakończona (sesja gotowa).");
      sharedMessenger.startConversationMessageWatcher();
    })
    .catch((err) =>
      console.error("Messenger: rozgrzewka nie powiodła się:", err?.message || err)
    );
  warmupERemiza()
    .then(() =>
      console.log(
        useApibetaEremiza()
          ? "e-Remiza: rozgrzewka zakończona — tryb tylko API beta (EREMIZA_USE_APIBETA)."
          : isApibetaDisabled()
            ? "e-Remiza: rozgrzewka zakończona — tylko Chromium (EREMIZA_APIBETA_DISABLED)."
            : "e-Remiza: rozgrzewka zakończona — hybryda: domyślnie API beta, przy błędzie Chromium (szczegóły powyżej)."
      )
    )
    .catch((err) =>
      console.error("e-Remiza: rozgrzewka nie powiodła się:", err?.message || err)
    );
});
