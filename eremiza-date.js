/** Jednolity zapis i porównanie czasu alarmu (Gist vs API vs Chromium). */

const WARSAW = "Europe/Warsaw";

function formatPartsToRecord(parts) {
  const o = {};
  for (const p of parts) {
    if (p.type !== "literal") o[p.type] = p.value;
  }
  return {
    y: Number(o.year),
    mo: Number(o.month),
    d: Number(o.day),
    h: Number(o.hour),
    mi: Number(o.minute),
  };
}

function warsawParts(ms) {
  return formatPartsToRecord(
    new Intl.DateTimeFormat("en-US", {
      timeZone: WARSAW,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms))
  );
}

/**
 * Konwersja „ściany zegara” w Warszawie → znacznik UTC (bez zależności od strefy serwera).
 */
function wallWarsawToUtcMs(y, mo, d, h, mi) {
  let ms = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  for (let i = 0; i < 48; i++) {
    const w = warsawParts(ms);
    const gotAsUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
    const wantAsUtc = Date.UTC(y, mo - 1, d, h, mi);
    const delta = wantAsUtc - gotAsUtc;
    if (delta === 0) return ms;
    ms += delta;
  }
  return ms;
}

function parseFlexibleToUtcMs(input) {
  const s = String(input).trim();
  if (!s) return NaN;
  const isoMs = Date.parse(s);
  if (!Number.isNaN(isoMs)) return isoMs;
  const m = s.match(
    /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/
  );
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    const h = m[4] != null ? Number(m[4]) : 0;
    const mi = m[5] != null ? Number(m[5]) : 0;
    return wallWarsawToUtcMs(y, mo, d, h, mi);
  }
  return NaN;
}

function formatDdMmYyyyHm(ms) {
  const w = warsawParts(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(w.d)}-${pad(w.mo)}-${w.y} ${pad(w.h)}:${pad(w.mi)}`;
}

/**
 * Zwraca datę alarmu zawsze jako `DD-MM-YYYY HH:mm` (czas w Europe/Warsaw),
 * niezależnie od źródła (ISO z API, tekst z Chromium). Przy braku parsowania — surowy trim.
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeEremizaDateField(input) {
  if (input == null) return "";
  const ms = parseFlexibleToUtcMs(input);
  if (Number.isNaN(ms)) return String(input).trim();
  return formatDdMmYyyyHm(ms);
}
