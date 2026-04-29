import { normalizeEremizaDateField } from "./eremiza-date.js";

/**
 * e-Remiza: POST token (JWT w Cookie) → GET /incident/api/alarm.
 * Jak w przeglądarce: opcjonalnie XSRF-TOKEN w Cookie + nagłówek x-xsrf-token; scalamy Set-Cookie z odpowiedzi.
 * UI: https://e-remiza.pl/auth-app/auth/login
 */

const DEFAULT_BASE = "https://api.e-remiza.pl";
const TOKEN_PATH = "/common/api/authentication/token";
const DEFAULT_ORIGIN = "https://e-remiza.pl";

const SESSION_REFRESH_MS =
  Number(process.env.EREMIZA_SESSION_REFRESH_MS) || 9 * 60 * 1000;

export function useApibetaEremiza() {
  const v = process.env.EREMIZA_USE_APIBETA?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Wyłącza próbę API — tylko Chromium (stary panel). */
export function isApibetaDisabled() {
  const v = process.env.EREMIZA_APIBETA_DISABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Domyślnie: najpierw API beta, potem ewentualnie Chromium (chyba że wyłączone lub tryb tylko-API). */
export function tryApibetaBeforeChromium() {
  return !isApibetaDisabled();
}

function apibetaBase() {
  return (process.env.EREMIZA_APIBETA_BASE?.trim() || DEFAULT_BASE).replace(
    /\/$/,
    ""
  );
}

function browserLikeHeaders() {
  const origin =
    process.env.EREMIZA_APIBETA_ORIGIN?.trim() || DEFAULT_ORIGIN;
  return {
    Accept: "application/json",
    Origin: origin,
    Referer: `${origin}/`,
  };
}

/** Z linii Set-Cookie → fragment nagłówka Cookie (tylko name=value). */
function cookieHeaderFromSetCookieLines(lines) {
  const pairs = [];
  for (const line of lines) {
    const nv = line.split(";")[0].trim();
    const eq = nv.indexOf("=");
    if (eq > 0) pairs.push(nv);
  }
  return pairs.join("; ");
}

/** Scala istniejący nagłówek Cookie z nowymi Set-Cookie (nadpisuje te same nazwy). */
function mergeCookieHeaderWithSetCookieLines(existing, lines) {
  const m = new Map();
  if (existing) {
    for (const part of existing.split(";")) {
      const p = part.trim();
      const i = p.indexOf("=");
      if (i > 0) m.set(p.slice(0, i), p.slice(i + 1));
    }
  }
  for (const line of lines) {
    const nv = line.split(";")[0].trim();
    const i = nv.indexOf("=");
    if (i > 0) m.set(nv.slice(0, i), nv.slice(i + 1));
  }
  return [...m.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function getSetCookieLines(res) {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  return [];
}

function mergeResponseCookies(res) {
  const lines = getSetCookieLines(res);
  if (!lines.length) return;
  cookieHeader = mergeCookieHeaderWithSetCookieLines(cookieHeader, lines);
}

/** Wartość ciastka (bez dekodowania URL — nagłówek x-xsrf-token zwykle = surowa wartość jak w Cookie). */
function extractCookieValue(header, name) {
  if (!header) return null;
  const want = name.toLowerCase();
  for (const part of header.split(";")) {
    const p = part.trim();
    const i = p.indexOf("=");
    if (i <= 0) continue;
    if (p.slice(0, i).toLowerCase() === want) return p.slice(i + 1);
  }
  return null;
}

/** Cookie + Origin/Referer + x-xsrf-token (wymagane przez API jak w przeglądarce). */
function buildApiRequestHeaders() {
  const h = {
    Cookie: cookieHeader,
    ...browserLikeHeaders(),
  };
  const xsrf = extractCookieValue(cookieHeader, "XSRF-TOKEN");
  if (xsrf) {
    h["x-xsrf-token"] = xsrf;
  }
  return h;
}

let cookieHeader = "";
let lastAuthAt = 0;

async function fetchTokenCookies() {
  const login = process.env.EREMIZA_LOGIN;
  const password = process.env.EREMIZA_PASSWORD;
  if (!login || !password) {
    throw new Error(
      "e-Remiza API beta: ustaw EREMIZA_LOGIN i EREMIZA_PASSWORD"
    );
  }

  const url = `${apibetaBase()}${TOKEN_PATH}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...browserLikeHeaders(),
    },
    body: JSON.stringify({ login, password }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(
      `e-Remiza API beta: logowanie HTTP ${res.status} ${bodyText.slice(0, 300)}`
    );
  }

  let setCookieLines = [];
  if (typeof res.headers.getSetCookie === "function") {
    setCookieLines = res.headers.getSetCookie();
  }

  const combined = cookieHeaderFromSetCookieLines(setCookieLines);
  if (!combined) {
    throw new Error(
      "e-Remiza API beta: brak Set-Cookie po logowaniu (wymagany Node z getSetCookie na odpowiedzi fetch)"
    );
  }

  cookieHeader = combined;
  lastAuthAt = Date.now();
}

export async function ensureApibetaSession() {
  const stale =
    !cookieHeader || Date.now() - lastAuthAt >= SESSION_REFRESH_MS;
  if (stale) {
    console.log("e-Remiza API beta: logowanie (POST token + ciasteczka)…");
    await fetchTokenCookies();
  }
}

function mapApiItemToAlert(item) {
  const type = [item.subKind, item.subType].filter(Boolean).join(" — ");
  const addressParts = [
    item.locality,
    item.street,
    item.addressPoint,
  ].filter(Boolean);
  const address = addressParts.join(", ") || item.locality || "";
  return {
    date: normalizeEremizaDateField(item.acquired),
    incidentId: item.id,
    type,
    address,
    description: item.description?.trim() ?? "",
    author:
      [item.dispatchedBsisName, item.bsisElementName]
        .filter(Boolean)
        .join(" · ") || "",
    coords: [Number(item.latitude), Number(item.longitude)],
  };
}

async function fetchAlarmsJson(allowReauth) {
  await ensureApibetaSession();

  const lookbackDays = Number(process.env.EREMIZA_API_LOOKBACK_DAYS) || 7;
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    dateFrom: from.toISOString(),
    dateTo: to.toISOString(),
  });
  const url = `${apibetaBase()}/incident/api/alarm?${params}`;

  const runOnce = async () => {
    const hadXsrf = Boolean(extractCookieValue(cookieHeader, "XSRF-TOKEN"));
    const res = await fetch(url, { headers: buildApiRequestHeaders() });
    mergeResponseCookies(res);
    return { res, hadXsrf };
  };

  let { res, hadXsrf } = await runOnce();

  // Po pierwszym GET serwer może ustawić XSRF-TOKEN — przy błędzie powtórz z nagłówkiem x-xsrf-token.
  if (
    !res.ok &&
    !hadXsrf &&
    extractCookieValue(cookieHeader, "XSRF-TOKEN")
  ) {
    ({ res } = await runOnce());
  }

  if ((res.status === 401 || res.status === 403) && allowReauth) {
    cookieHeader = "";
    lastAuthAt = 0;
    return fetchAlarmsJson(false);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `e-Remiza API beta: alarmy HTTP ${res.status} ${errBody.slice(0, 200)}`
    );
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("e-Remiza API beta: oczekiwano tablicy JSON przy alarmach");
  }

  mergeResponseCookies(res);

  return data;
}

export async function fetchLatestAlertApibeta() {
  let data = await fetchAlarmsJson(true);

  const orgRaw = process.env.EREMIZA_ORG_UNIT_ID?.trim();
  if (orgRaw) {
    const orgId = Number(orgRaw);
    data = data.filter((x) => x.organizationUnitId === orgId);
  }

  const active = data.filter((x) => !x.isDeleted);
  active.sort(
    (a, b) => new Date(b.acquired).getTime() - new Date(a.acquired).getTime()
  );

  const latest = active[0];
  if (!latest) return null;

  return mapApiItemToAlert(latest);
}

export function isSameEremizaAsGist(alert, gist) {
  if (!gist || !alert?.date) return false;
  const gId = gist.incidentId;
  const aId = alert.incidentId;
  if (gId != null && aId != null) {
    return Number(gId) === Number(aId);
  }
  const ndA = normalizeEremizaDateField(alert.date);
  const ndG = normalizeEremizaDateField(gist.date);
  return ndA !== "" && ndG !== "" && ndA === ndG;
}

/** Keep-alive: sesja + jedno zapytanie o alarmy (jak przy normalnym odczycie). */
export async function keepAliveApibetaTick() {
  try {
    await fetchAlarmsJson(true);
    return {
      source: "apibeta",
      sessionOk: Boolean(cookieHeader),
      apiOk: true,
    };
  } catch {
    return {
      source: "apibeta",
      sessionOk: Boolean(cookieHeader),
      apiOk: false,
    };
  }
}

/** Unieważnij ciasteczka (np. testy). */
export function clearApibetaSession() {
  cookieHeader = "";
  lastAuthAt = 0;
}
