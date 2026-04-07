/**
 * Szybki test: POST token + GET /incident/api/alarm (bez Messengera i bez Chromium).
 * Wymaga w .env: EREMIZA_LOGIN, EREMIZA_PASSWORD (opcjonalnie EREMIZA_ORG_UNIT_ID, EREMIZA_APIBETA_*).
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const { clearApibetaSession, fetchLatestAlertApibeta } = await import(
  path.join(root, "eremiza-apibeta.js")
);

console.log("Test apibeta.e-remiza.pl (logowanie + ostatni alarm)…");
clearApibetaSession();

try {
  const alert = await fetchLatestAlertApibeta();
  if (alert) {
    console.log(JSON.stringify(alert, null, 2));
    console.log("— OK: pobrano ostatni alarm.");
  } else {
    console.log("— OK: brak alarmów w zadanym oknie dat (pusta lista).");
  }
} catch (e) {
  console.error("— BŁĄD:", e?.message ?? e);
  process.exit(1);
}
