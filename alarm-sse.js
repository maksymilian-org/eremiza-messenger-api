/**
 * Server-Sent Events: natychmiastowe powiadomienia o nowym alarmie (bez odpytywania).
 * Klient (inna strona / backend): EventSource + nasłuch zdarzenia `alarm`.
 *
 * Opcjonalnie: ALARM_SSE_TOKEN w .env — wymagany ?token=... albo nagłówek Authorization: Bearer ...
 * Dla innej domeny/portu: ALARM_SSE_ALLOW_ORIGIN (np. * albo http://127.0.0.1:3000) — CORS.
 */

const clients = new Set();
/** Tylko keep-alive (proxy/idle) — NIE opóźnia wysyłki alarmu; `notifyNewAlarmSse` idzie od razu. */
const PING_MS = 25_000;

function getAllowOrigin() {
  const o = process.env.ALARM_SSE_ALLOW_ORIGIN?.trim();
  return o || null;
}

function tokenOk(req) {
  const t = process.env.ALARM_SSE_TOKEN?.trim();
  if (!t) return true;
  const q = String(req.query?.token ?? "");
  if (q === t) return true;
  const auth = String(req.headers.authorization || "");
  if (auth === `Bearer ${t}`) return true;
  return false;
}

/**
 * Wysyła do wszystkich połączonych klientów SSE ten sam ładunek, co trafia do tablicy (registerAlarmDispatch).
 * @param {{ registeredAt: string, alert: Record<string, unknown> }} dispatch
 */
export function notifyNewAlarmSse(dispatch) {
  const line = JSON.stringify(dispatch);
  for (const res of clients) {
    try {
      res.write(`event: alarm\ndata: ${line}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * @param {import('express').Application} app
 */
export function mountAlarmSse(app) {
  app.get("/alerts/events", (req, res) => {
    if (!tokenOk(req)) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    const origin = getAllowOrigin();
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }

    res.write(":connected\n\n");

    const ping = setInterval(() => {
      try {
        res.write(`:ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(ping);
        clients.delete(res);
      }
    }, PING_MS);

    const done = () => {
      clearInterval(ping);
      clients.delete(res);
    };
    res.on("close", done);
    req.on("aborted", done);

    clients.add(res);
    console.log(
      `[alarm-sse] klient: ${clients.size} aktywne połączenie/łączenia`,
    );
  });
}
