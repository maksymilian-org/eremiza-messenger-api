/**
 * Odczyt alarmów z REST API (np. apibeta.e-remiza.pl) — bez Puppeteera na stronie /alarmy.
 * Zwykle wymaga sesji: nagłówek Cookie skopiowany z przeglądarki po zalogowaniu (EREMIZA_API_COOKIE)
 * i/lub Bearer (EREMIZA_API_TOKEN), zależnie od konfiguracji serwera.
 */

const DEFAULT_API_BASE = "https://apibeta.e-remiza.pl";

function mapApiItemToAlert(item) {
  const type = [item.subKind, item.subType].filter(Boolean).join(" — ");
  const addressParts = [item.locality, item.addressPoint].filter(Boolean);
  const address = addressParts.join(", ") || item.locality || "";
  return {
    date: item.acquired,
    incidentId: item.id,
    type,
    address,
    description: item.description?.trim() ?? "",
    author:
      [item.dispatchedBsisName, item.bsisElementName].filter(Boolean).join(" · ") ||
      "",
    coords: [Number(item.latitude), Number(item.longitude)],
  };
}

export function useEremizaApi() {
  const v = process.env.EREMIZA_USE_API?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export async function fetchLatestAlertFromApi() {
  const base = (
    process.env.EREMIZA_API_BASE?.trim() || DEFAULT_API_BASE
  ).replace(/\/$/, "");
  const lookbackDays = Number(process.env.EREMIZA_API_LOOKBACK_DAYS) || 7;
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    dateFrom: from.toISOString(),
    dateTo: to.toISOString(),
  });
  const url = `${base}/incident/api/alarm?${params}`;

  const headers = { Accept: "application/json" };

  const cookie = process.env.EREMIZA_API_COOKIE?.trim();
  if (cookie) {
    headers.Cookie = cookie;
  }

  const cookieFile = process.env.EREMIZA_API_COOKIE_FILE?.trim();
  if (!headers.Cookie && cookieFile) {
    const { readFile } = await import("node:fs/promises");
    headers.Cookie = (await readFile(cookieFile, "utf8")).trim();
  }

  const token = process.env.EREMIZA_API_TOKEN?.trim();
  if (token) {
    headers.Authorization = token.startsWith("Bearer ")
      ? token
      : `Bearer ${token}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`e-Remiza API: HTTP ${res.status} ${res.statusText}`);
  }

  let data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("e-Remiza API: oczekiwano tablicy JSON");
  }

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
  if (!latest) {
    return null;
  }

  return mapApiItemToAlert(latest);
}

/** Porównanie z ostatnim zapisem w Gist — `incidentId` jeśli oba istnieją, inaczej `date`. */
export function isSameEremizaAsGist(alert, gist) {
  if (!gist || !alert?.date) return false;
  const gId = gist.incidentId;
  const aId = alert.incidentId;
  if (gId != null && aId != null) {
    return Number(gId) === Number(aId);
  }
  return gist.date === alert.date;
}
