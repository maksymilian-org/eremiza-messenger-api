import https from "node:https";

function buildTelegramMessage(alert, shortLink) {
  const parts = [];
  if (alert.type)        parts.push(`🚨 <b>${escHtml(String(alert.type))}</b>`);
  if (alert.address)     parts.push(`📍 ${escHtml(String(alert.address))}`);
  if (alert.description) parts.push(`📋 ${escHtml(String(alert.description))}`);
  if (shortLink)         parts.push(`🧭 ${shortLink}`);
  return parts.join("\n");
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Wysyła szczegóły alarmu na Telegram.
 * Wymaga TELEGRAM_BOT_TOKEN i TELEGRAM_CHAT_ID w .env.
 * Rzuca błąd gdy nie skonfigurowano lub API odpowie błędem.
 */
export async function sendTelegramAlarm(alert, shortLink) {
  const token  = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    throw new Error("Telegram: brak TELEGRAM_BOT_TOKEN lub TELEGRAM_CHAT_ID w .env");
  }

  const text = buildTelegramMessage(alert, shortLink);
  const url  = `https://api.telegram.org/bot${token}/sendMessage`;
  const result = await postJson(url, { chat_id: chatId, text, parse_mode: "HTML" });

  if (!result.body?.ok) {
    throw new Error(
      `Telegram API error ${result.status}: ${JSON.stringify(result.body)}`
    );
  }
  return result.body;
}
