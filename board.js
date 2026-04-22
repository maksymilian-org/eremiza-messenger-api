import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALARM_REACTION_FOLLOWUP_LINES } from "./alarm-followups.js";
import { notifyNewAlarmSse } from "./alarm-sse.js";

/** Katalog pakietu (obok `board.js`), niezależnie od `process.cwd()` przy starcie skryptów. */
const boardPackageRoot = path.dirname(fileURLToPath(import.meta.url));

/** @typedef {{ id: string, author: string, text: string, reactionAriaLabels: string[] }} ChatRow */

let activeAlarm = null;
/** @type {string | null} */
let lastIngestAt = null;

/** @type {Map<string, Map<string, { ariaLabels: Set<string> }>>} opcja -> imię/nick -> szczegóły */
const reactorsByOption = new Map();

/** Ostatnie wiadomości tekstowe z czatu (id z DOM — deduplikacja). */
const MAX_CHAT_MESSAGES = 200;
const chatMessagesById = new Map();
/** @type {string[]} */
const chatMessageOrder = [];

function clearChatMessages() {
  chatMessagesById.clear();
  chatMessageOrder.length = 0;
}

function ensureOptionMap(optionLabel) {
  if (!reactorsByOption.has(optionLabel)) {
    reactorsByOption.set(optionLabel, new Map());
  }
  return reactorsByOption.get(optionLabel);
}

function resetBoard() {
  clearChatMessages();
  reactorsByOption.clear();
  for (const line of ALARM_REACTION_FOLLOWUP_LINES) {
    reactorsByOption.set(line, new Map());
  }
}

/**
 * Wywołaj po wysłaniu nowego alarmu (+ follow-upów) na Messenger.
 * @param {Record<string, unknown>} alertPayload — np. obiekt z e-Remiza zapisany do gista
 */
export function registerAlarmDispatch(alertPayload) {
  activeAlarm = {
    registeredAt: new Date().toISOString(),
    alert: alertPayload && typeof alertPayload === "object" ? { ...alertPayload } : {},
  };
  notifyNewAlarmSse({
    registeredAt: activeAlarm.registeredAt,
    alert: activeAlarm.alert,
  });
  resetBoard();
  scheduleBoardSnapshotWrite();
}

/**
 * Wyciąga imiona z typowych etykiet Meta (EN/PL), bez gwarancji — DOM bywa różny.
 * @param {string} aria
 * @returns {string[]}
 */
export function parseNamesFromReactionAria(aria) {
  if (!aria || typeof aria !== "string") return [];
  const a = aria.replace(/\s+/g, " ").trim();
  const out = new Set();

  const pushSplit = (s) => {
    for (const part of s.split(",")) {
      const n = part.replace(/\s+and\s+\d+\s+others?$/i, "").trim();
      if (n.length > 1 && n.length < 120) out.add(n);
    }
  };

  const mOthers = a.match(
    /^(.+?)\s+and\s+\d+\s+others?\s+(reacted|zareagował)/i,
  );
  if (mOthers) {
    pushSplit(mOthers[1]);
    return [...out];
  }

  const mYou = a.match(/^You\s+(reacted|zareagował)/i);
  if (mYou) {
    out.add("Ty (You)");
    return [...out];
  }

  const mEn = a.match(/^(.+?)\s+reacted with/i);
  if (mEn) {
    out.add(mEn[1].trim());
    return [...out];
  }

  const mPl = a.match(/^(.+?)\s+zareagował/i);
  if (mPl) {
    out.add(mPl[1].trim().replace(/\s*\(a\)\s*$/i, ""));
    return [...out];
  }

  const mSee = a.match(/See who reacted|Zobacz.*zareagował/i);
  if (mSee && a.length < 200) return [];

  return [...out];
}

function rowMatchesFollowup(text, optionLine) {
  if (!text || !optionLine) return false;
  const t = text;
  return t.includes(optionLine);
}

function shouldRecordChatMessage(text) {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 2) return false;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return false;
  if (/^https?:\/\/\S+$/i.test(t) && t.length < 400) return false;
  if (/^blob:/i.test(t)) return false;
  for (const line of ALARM_REACTION_FOLLOWUP_LINES) {
    if (t === line.trim()) return false;
  }
  if (/^(photo|image|video|gif|sticker|tap to open|dotknij|wyślij)/i.test(t) && t.length < 48) {
    return false;
  }
  if (/^(Zdjęcie|Wideo|GIF|Naklejka|Miniatur)/i.test(t) && t.length < 48) return false;
  if (/reacted to your message|zareagował\(a\)? na Twoją wiadomość/i.test(t)) {
    return false;
  }
  if (/^(głosowa|voice message|udostępniona lok|shared location)/i.test(t) && t.length < 60) {
    return false;
  }
  if (!/[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ0-9]/.test(t) && t.length < 30) return false;
  return true;
}

function clipChatText(t, max = 720) {
  const s = String(t || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function recordChatMessageFromRow(row) {
  const raw = String(row.text || "").trim();
  if (!shouldRecordChatMessage(raw)) return;
  const id = row.id;
  if (!id || chatMessagesById.has(id)) return;
  const author = String(row.author || "nieznany")
    .replace(/\s+/g, " ")
    .trim();
  chatMessagesById.set(id, {
    author,
    text: clipChatText(raw),
    at: new Date().toISOString(),
  });
  chatMessageOrder.push(id);
  while (chatMessageOrder.length > MAX_CHAT_MESSAGES) {
    const old = chatMessageOrder.shift();
    if (old) chatMessagesById.delete(old);
  }
}

function serializeChatMessages() {
  return [...chatMessageOrder]
    .slice()
    .reverse()
    .map((id) => {
      const m = chatMessagesById.get(id);
      if (!m) return null;
      return { id, author: m.author, text: m.text, at: m.at };
    })
    .filter(Boolean);
}

/**
 * @param {ChatRow[]} rows
 */
export function ingestChatSnapshot(rows) {
  lastIngestAt = new Date().toISOString();
  if (!Array.isArray(rows)) return;

  for (const row of rows) {
    const text = String(row.text || "");
    const labels = Array.isArray(row.reactionAriaLabels)
      ? row.reactionAriaLabels
      : [];

    for (const optionLine of ALARM_REACTION_FOLLOWUP_LINES) {
      if (!rowMatchesFollowup(text, optionLine)) continue;
      const optMap = ensureOptionMap(optionLine);
      for (const aria of labels) {
        for (const name of parseNamesFromReactionAria(aria)) {
          if (!optMap.has(name)) optMap.set(name, { ariaLabels: new Set() });
          optMap.get(name).ariaLabels.add(aria);
        }
      }
    }

    recordChatMessageFromRow(row);
  }
  scheduleBoardSnapshotWrite();
}

function boardSecretOk(req) {
  const need = process.env.REACTION_BOARD_SECRET?.trim();
  if (!need) return true;
  const q = req.query?.secret;
  const h = req.headers?.authorization;
  const bearer =
    typeof h === "string" && h.startsWith("Bearer ")
      ? h.slice(7).trim()
      : "";
  return q === need || bearer === need;
}

export function getBoardArrivalsPath() {
  return (
    process.env.BOARD_ARRIVALS_PATH?.trim() ||
    path.join(boardPackageRoot, ".data", "board-arrivals.json")
  );
}

function readArrivalsStoreRaw() {
  try {
    const j = JSON.parse(readFileSync(getBoardArrivalsPath(), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeArrivalsStoreRaw(store) {
  const file = getBoardArrivalsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store), "utf8");
}

/** Klucz zgłoszenia dla stanu „na remizie” (zgodny z klientem / plikiem JSON). */
export function boardArrivalStorageKey(data) {
  const alarm = data?.activeAlarm;
  const id =
    alarm?.alert &&
    typeof alarm.alert === "object" &&
    alarm.alert.incidentId != null &&
    String(alarm.alert.incidentId).trim()
      ? String(alarm.alert.incidentId).trim()
      : alarm?.registeredAt != null && String(alarm.registeredAt).trim()
        ? String(alarm.registeredAt).trim()
        : "brak-zgloszenia";
  return `boardArrived:v1:${id}`;
}

export function getArrivedNamesForPayload(data) {
  const key = boardArrivalStorageKey(data);
  const raw = readArrivalsStoreRaw();
  const arr = raw[key];
  return Array.isArray(arr)
    ? arr.map((x) => String(x).trim()).filter(Boolean)
    : [];
}

export function toggleArrivalForData(name, data) {
  const nm = String(name ?? "").trim();
  if (!nm) return getArrivedNamesForPayload(data);
  const key = boardArrivalStorageKey(data);
  const raw = readArrivalsStoreRaw();
  const store =
    raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  const prev = store[key];
  const set = new Set(
    Array.isArray(prev)
      ? prev.map((x) => String(x).trim()).filter(Boolean)
      : [],
  );
  if (set.has(nm)) set.delete(nm);
  else set.add(nm);
  const next = Array.from(set);
  store[key] = next;
  writeArrivalsStoreRaw(store);
  scheduleBoardSnapshotWrite();
  return next;
}

function stripDemoArrivalSeedFromPayload(data) {
  if (!data || typeof data !== "object") return data;
  const rest = { ...data };
  delete rest.demoArrivedNames;
  return rest;
}

export function mergeArrivedNamesIntoPayload(data) {
  const demoSeed = Array.isArray(data?.demoArrivedNames)
    ? data.demoArrivedNames.map((x) => String(x).trim()).filter(Boolean)
    : null;
  const base = stripDemoArrivalSeedFromPayload(data);
  const fromFile = getArrivedNamesForPayload(base);
  const isDemoIncident =
    base?.activeAlarm?.alert &&
    String(base.activeAlarm.alert.incidentId ?? "").trim() === "demo-json";
  const arrivedNames =
    isDemoIncident && demoSeed && fromFile.length === 0 ? demoSeed : fromFile;
  return {
    ...base,
    arrivedNames,
    remiza: buildRemizaPayloadForData({ ...base, arrivedNames }),
  };
}

export function resolveBoardDataForArrivalKey(req) {
  let data = getBoardPayload();
  if (isDemoQuery(req)) {
    const demo = loadDemoBoardPayload();
    if (demo) data = demo;
  }
  return data;
}

export function buildBoardArrivalToggleHref(basePath, req) {
  const bp = String(basePath || "/board").replace(/\/$/, "");
  const q = new URLSearchParams();
  const sec = req?.query?.secret;
  if (sec != null && String(sec).length) q.set("secret", String(sec));
  if (req && isDemoQuery(req)) q.set("demo", "1");
  const qs = q.toString();
  return `${bp}/arrival/toggle${qs ? `?${qs}` : ""}`;
}

export function buildBoardRemizaMutationHref(basePath, req) {
  const bp = String(basePath || "/board").replace(/\/$/, "");
  const q = new URLSearchParams();
  const sec = req?.query?.secret;
  if (sec != null && String(sec).length) q.set("secret", String(sec));
  if (req && isDemoQuery(req)) q.set("demo", "1");
  const qs = q.toString();
  return `${bp}/remiza${qs ? `?${qs}` : ""}`;
}

function serializeBoard() {
  const byOption = {};
  for (const line of ALARM_REACTION_FOLLOWUP_LINES) {
    const m = reactorsByOption.get(line) || new Map();
    byOption[line] = [...m.entries()].map(([name, v]) => ({
      name,
      ariaLabels: [...(v.ariaLabels || [])],
    }));
  }
  return {
    generatedAt: new Date().toISOString(),
    lastIngestAt,
    activeAlarm,
    followupOptions: ALARM_REACTION_FOLLOWUP_LINES,
    reactionsByOption: byOption,
    chatMessages: serializeChatMessages(),
    arrivedNames: getArrivedNamesForPayload({ activeAlarm }),
    remiza: buildRemizaPayloadForData({ activeAlarm }),
  };
}

export function getBoardPayload() {
  return serializeBoard();
}

/** `?demo=1` / `?demo=true` — payload z pliku JSON (testy UI, bez wpływu na stan czatu). */
export function isDemoQuery(req) {
  const v = req.query?.demo;
  return v === "1" || String(v).toLowerCase() === "true";
}

/** Ścieżka do JSON z pełnym payloadem tablicy (jak z `/board.json`). */
export function demoBoardPayloadPath() {
  return (
    process.env.BOARD_DEMO_JSON?.trim() ||
    path.join(boardPackageRoot, "board-demo.payload.json")
  );
}

/**
 * Wczytuje `board-demo.payload.json` (lub `BOARD_DEMO_JSON`).
 * Klucze w `reactionsByOption` muszą odpowiadać liniom z `alarm-followups.js`.
 * Opcjonalnie `chatMessages` — jak w `/board.json`.
 * Opcjonalnie `demoArrivedNames` (tablica imion): gdy `alert.incidentId` to `demo-json`
 * i w pliku przybyć nie ma jeszcze wpisu dla tego zgłoszenia, używane jako startowy stan „na remizie”.
 * @returns {object | null}
 */
export function loadDemoBoardPayload() {
  const file = demoBoardPayloadPath();
  try {
    const raw = readFileSync(file, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    if (!j.reactionsByOption || typeof j.reactionsByOption !== "object") {
      console.warn("[board] demo JSON: brak pola reactionsByOption —", file);
      return null;
    }
    return j;
  } catch (e) {
    console.warn("[board] demo JSON:", file, "—", e?.message || e);
    return null;
  }
}

export function boardJsonHrefWithDemo(basePath, secQ, req) {
  const base = `${basePath}.json${secQ}`;
  if (!isDemoQuery(req)) return base;
  return base.includes("?") ? `${base}&demo=1` : `${base}?demo=1`;
}

export function isBoardSnapshotSyncEnabled() {
  const v = process.env.BOARD_SNAPSHOT_SYNC?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function boardSnapshotPath() {
  return (
    process.env.BOARD_SNAPSHOT_PATH?.trim() ||
    path.join(boardPackageRoot, ".data", "board-snapshot.json")
  );
}

let _snapshotTimer = null;

/** Zapisuje aktualny payload na dysk (dla osobnego `npm run board:ui`). */
export async function writeBoardSnapshotNow() {
  if (!isBoardSnapshotSyncEnabled()) return;
  const file = boardSnapshotPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(getBoardPayload()), "utf8");
}

export function scheduleBoardSnapshotWrite() {
  if (!isBoardSnapshotSyncEnabled()) return;
  clearTimeout(_snapshotTimer);
  _snapshotTimer = setTimeout(() => {
    void writeBoardSnapshotNow().catch((e) =>
      console.warn("[board] zapis snapshot:", e?.message || e),
    );
  }, 400);
}

/**
 * Middleware Express: 403 gdy ustawiono REACTION_BOARD_SECRET i brak poprawnego klucza.
 */
export function boardAuthMiddleware(req, res, next) {
  if (!boardSecretOk(req)) {
    res.status(403).send("Forbidden");
    return;
  }
  next();
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wartość atrybutu HTML (np. `data-*`). */
function escAttr(s) {
  return escHtml(s).replace(/\r|\n/g, " ");
}

const PILL_CHECK_SVG = `<svg class="pill__check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

/** @typedef {{ lookup: (displayName: string) => { dowodca: boolean, kierowca: boolean } }} FirefighterRoleMap */

let _ffRolesCache = { file: "", mtime: 0, map: /** @type {FirefighterRoleMap | null} */ (null) };

function parseFirefighterRolesJson(j) {
  const norm = (s) =>
    String(s ?? "")
      .trim()
      .toLocaleLowerCase("pl");
  /** @type {Set<string>} */
  const dow = new Set();
  /** @type {Set<string>} */
  const kie = new Set();
  const add = (set, arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const n = norm(item);
      if (n) set.add(n);
    }
  };
  if (j && typeof j === "object") {
    add(dow, j.dowodca ?? j["dowódca"]);
    add(kie, j.kierowca);
  }
  return {
    lookup(displayName) {
      const n = norm(displayName);
      if (!n) return { dowodca: false, kierowca: false };
      return {
        dowodca: dow.has(n),
        kierowca: kie.has(n),
      };
    },
  };
}

/**
 * Mapowanie imion (jak na tablicy / w Messengerze) na role: dowódca i/lub kierowca (obie naraz dozwolone).
 * Plik JSON: tablice `dowodca` / `kierowca` — wpisy dokładnie tak, jak mają być dopasowane
 * (np. „Jan”, „Jan K” z literą nazwiska, ksywa z ustawień konwersacji).
 * Ścieżka: `BOARD_FIREFIGHTER_ROLES_PATH` lub `board-firefighter-roles.json` w katalogu projektu.
 */
export function loadFirefighterRoleMap() {
  const file =
    process.env.BOARD_FIREFIGHTER_ROLES_PATH?.trim() ||
    path.join(boardPackageRoot, "board-firefighter-roles.json");
  try {
    const mtime = statSync(file).mtimeMs;
    if (
      _ffRolesCache.map &&
      _ffRolesCache.file === file &&
      _ffRolesCache.mtime === mtime
    ) {
      return _ffRolesCache.map;
    }
    const raw = readFileSync(file, "utf8");
    const j = JSON.parse(raw);
    const map = parseFirefighterRolesJson(j);
    _ffRolesCache = { file, mtime, map };
    return map;
  } catch (e) {
    const empty = parseFirefighterRolesJson(null);
    _ffRolesCache = { file, mtime: 0, map: empty };
    if (process.env.BOARD_FIREFIGHTER_ROLES_PATH?.trim()) {
      console.warn("[board] BOARD_FIREFIGHTER_ROLES_PATH:", file, "—", e?.message || e);
    }
    return empty;
  }
}

export function getBoardRemizaStatePath() {
  return (
    process.env.BOARD_REMIZA_STATE_PATH?.trim() ||
    path.join(boardPackageRoot, ".data", "board-remiza-state.json")
  );
}

function readRemizaStoreRaw() {
  try {
    const j = JSON.parse(readFileSync(getBoardRemizaStatePath(), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeRemizaStoreRaw(store) {
  const file = getBoardRemizaStatePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store), "utf8");
}

function getRemizaManualForKey(alarmKey) {
  const raw = readRemizaStoreRaw();
  const o = raw[alarmKey];
  if (!o || typeof o !== "object") {
    return {
      headcount: 0,
      headcountManual: false,
      dowodca: false,
      kierowca: false,
    };
  }
  const rawHc = Math.floor(Number(o.headcount) || 0);
  return {
    headcount: Math.max(0, Math.min(6, rawHc)),
    headcountManual: !!o.headcountManual,
    dowodca: !!o.dowodca,
    kierowca: !!o.kierowca,
  };
}

function setRemizaManualForKey(alarmKey, partial) {
  const raw = readRemizaStoreRaw();
  const cur = getRemizaManualForKey(alarmKey);
  const next = { ...cur, ...partial };
  const store =
    raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  store[alarmKey] = next;
  writeRemizaStoreRaw(store);
  scheduleBoardSnapshotWrite();
  return next;
}

function normalizeArrivedNameList(arrivedNames) {
  const arr = Array.isArray(arrivedNames) ? arrivedNames : [];
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
}

/** Kierowca z przybyć: wystarczy jedna osoba z uprawnieniami K. */
function autoKierowcaFromArrivals(arrivedNames, roleMap) {
  const names = normalizeArrivedNameList(arrivedNames);
  return names.some((n) => roleMap?.lookup?.(n)?.kierowca);
}

/**
 * Dowódca z przybyć: osoba tylko-D liczy się od razu; osoba D+K dopiero gdy jest
 * inna potwierdzona osoba z uprawnieniami kierowcy (K ma pierwszeństwo — nie pełni się obu ról naraz).
 */
function autoDowodcaFromArrivalsWithKPriority(arrivedNames, roleMap) {
  const names = normalizeArrivedNameList(arrivedNames);
  return names.some((n) => {
    const r = roleMap?.lookup?.(n);
    if (!r?.dowodca) return false;
    if (r.kierowca) {
      return names.some(
        (other) => other !== n && !!roleMap?.lookup?.(other)?.kierowca,
      );
    }
    return true;
  });
}

export function computeRemizaDisplay(data, arrivedNames, roleMap) {
  const key = boardArrivalStorageKey(data);
  const m = getRemizaManualForKey(key);
  const names = normalizeArrivedNameList(arrivedNames);
  const headcountAuto = Math.min(6, names.length);
  const headcount = m.headcountManual
    ? Math.max(1, Math.min(6, m.headcount))
    : headcountAuto;
  const autoD = autoDowodcaFromArrivalsWithKPriority(arrivedNames, roleMap);
  const autoK = autoKierowcaFromArrivals(arrivedNames, roleMap);
  return {
    headcount,
    headcountAuto,
    headcountManual: m.headcountManual,
    dowodca: !!(m.dowodca || autoD),
    kierowca: !!(m.kierowca || autoK),
    dowodcaManual: m.dowodca,
    kierowcaManual: m.kierowca,
    dowodcaFromArrivals: autoD,
    kierowcaFromArrivals: autoK,
  };
}

export function buildRemizaPayloadForData(data) {
  const arrivedNames = Array.isArray(data.arrivedNames)
    ? data.arrivedNames
    : getArrivedNamesForPayload(data);
  return computeRemizaDisplay(data, arrivedNames, loadFirefighterRoleMap());
}

/** Ustawia ręcznie liczbę potwierdzonych (1–6) i blokuje podążanie za liczbą przybyć do remizy. */
export function remizaSetHeadcountChoice(data, value) {
  const key = boardArrivalStorageKey(data);
  let v = Math.floor(Number(value));
  if (!Number.isFinite(v)) v = 1;
  v = Math.max(1, Math.min(6, v));
  setRemizaManualForKey(key, { headcount: v, headcountManual: true });
  return buildRemizaPayloadForData(data);
}

export function remizaToggleRoleManual(data, role) {
  const key = boardArrivalStorageKey(data);
  const cur = getRemizaManualForKey(key);
  if (role === "dowodca") {
    setRemizaManualForKey(key, { dowodca: !cur.dowodca });
  } else if (role === "kierowca") {
    setRemizaManualForKey(key, { kierowca: !cur.kierowca });
  }
  return buildRemizaPayloadForData(data);
}

const REMIZA_CHECK_SVG = `<svg class="remiza-role__svg remiza-role__svg--check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

/** @param {string} label — tekst na przycisku (np. skrót). @param {string} [ariaLabelFull] — pełna nazwa do aria-label (czytniki ekranu). */
function renderRemizaRoleButton(role, label, on, ariaLabelFull) {
  const aria = ariaLabelFull || label;
  const onClass = on ? " remiza-role--on" : " remiza-role--off";
  const icon = on
    ? REMIZA_CHECK_SVG
    : `<span class="remiza-role__zero" aria-hidden="true">0</span>`;
  const pressed = on ? "true" : "false";
  return `<button type="button" class="remiza-role${onClass}" data-remiza-role="${role}" aria-pressed="${pressed}" aria-label="${escAttr(aria)}: ${on ? "tak" : "nie"}">
    <span class="remiza-role__iconwrap">${icon}</span>
    <span class="remiza-role__label">${escHtml(label)}</span>
  </button>`;
}

function renderRemizaHeadcountButtons(rm) {
  const active = Number(rm.headcount) || 0;
  const parts = [];
  for (let i = 1; i <= 6; i += 1) {
    const on = active === i;
    const cls = on ? " remiza-num--active" : "";
    const pressed = on ? "true" : "false";
    parts.push(
      `<button type="button" class="remiza-num${cls}" data-remiza-headcount="${i}" role="radio" aria-checked="${pressed}" aria-label="Dotarło: ${i}">${i}</button>`,
    );
  }
  return parts.join("");
}

function renderRemizaSection(data, roleMap) {
  const rm = buildRemizaPayloadForData(data);
  const nums = renderRemizaHeadcountButtons(rm);
  const dBtn = renderRemizaRoleButton("dowodca", "Dow.", rm.dowodca, "Dowódca");
  const kBtn = renderRemizaRoleButton("kierowca", "Kier.", rm.kierowca, "Kierowca");
  return `<section class="section section--remiza" aria-label="Dotarło, liczba potwierdzonych strażaków">
    <div class="remiza">
      <h2 class="remiza__title">Dotarło:</h2>
      <div class="remiza__counter" role="radiogroup" aria-label="Dotarło: liczba potwierdzonych (1–6)">
        ${nums}
      </div>
      <div class="remiza__rolebtns">${dBtn}${kBtn}</div>
    </div>
  </section>`;
}

function renderRoleBadges(roles) {
  if (!roles || (!roles.dowodca && !roles.kierowca)) return "";
  const parts = [];
  if (roles.dowodca) {
    parts.push(
      `<span class="pill__role pill__role--d" title="Dowódca" aria-hidden="true">D</span>`,
    );
  }
  if (roles.kierowca) {
    parts.push(
      `<span class="pill__role pill__role--k" title="Kierowca" aria-hidden="true">K</span>`,
    );
  }
  return `<span class="pill__roles">${parts.join("")}</span>`;
}

function arrivalAriaLabel(name, roles) {
  const n = String(name ?? "").trim();
  const d = roles?.dowodca;
  const k = roles?.kierowca;
  if (!d && !k) {
    return `Kliknij, aby oznaczyć lub odznaczyć dotarcie do remizy: ${n}`;
  }
  if (d && k) {
    return `Dowódca i kierowca: ${n}. Kliknij, aby oznaczyć lub odznaczyć dotarcie do remizy.`;
  }
  if (d) return `Dowódca ${n}. Kliknij, aby oznaczyć lub odznaczyć dotarcie do remizy.`;
  return `Kierowca ${n}. Kliknij, aby oznaczyć lub odznaczyć dotarcie do remizy.`;
}

function renderArrivalPill(name, minor, roleMap, arrivedSet) {
  const attr = escAttr(name);
  const minorClass = minor ? " pill--arrival--minor" : "";
  const arrived = arrivedSet?.has?.(name) === true;
  const arrivedClass = arrived ? " pill--arrived" : "";
  const roles = roleMap?.lookup?.(name) ?? {
    dowodca: false,
    kierowca: false,
  };
  const roleHtml = renderRoleBadges(roles);
  const aria = escAttr(arrivalAriaLabel(name, roles));
  const pressed = arrived ? "true" : "false";
  return `<span class="pill pill--arrival${minorClass}${arrivedClass}" role="button" tabindex="0" data-arrival-name="${attr}" aria-label="${aria}" title="Kliknij, aby oznaczyć lub odznaczyć dotarcie do remizy" aria-pressed="${pressed}">${roleHtml}<span class="pill__check" aria-hidden="true">${PILL_CHECK_SVG}</span><span class="pill__text">${escHtml(name)}</span></span>`;
}

function formatPlDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("pl-PL", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

/** Czas „temu” dla listy wiadomości: „35 s”, „1 min”, … względem `nowMs` (np. moment renderu). */
function formatRelativeAgoPl(iso, nowMs = Date.now()) {
  if (!iso) return "—";
  let t;
  try {
    t = new Date(iso).getTime();
  } catch {
    return "—";
  }
  if (Number.isNaN(t)) return "—";
  let sec = Math.floor((nowMs - t) / 1000);
  if (sec < 0) sec = 0;
  if (sec < 8) return "teraz";
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(sec / 3600);
  if (h < 48) return `${h} godz.`;
  const d = Math.floor(sec / 86400);
  if (d < 14) return `${d} d`;
  try {
    return new Intl.DateTimeFormat("pl-PL", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return "—";
  }
}

/**
 * Zwięzły kontekst zgłoszenia (typ + adres). Bez mapy i opisu — szczegóły w innych narzędziach.
 */
function renderAlertPanel(alert) {
  if (!alert || typeof alert !== "object") {
    return `<div class="card card--muted"><p class="card__lead">Brak aktywnego zgłoszenia na tablicy.</p><p class="card__hint">Po następnym alarmie z e-Remiza dane pojawią się tutaj automatycznie.</p></div>`;
  }

  const type = alert.type != null ? escHtml(String(alert.type)) : "";
  const address = alert.address != null ? escHtml(String(alert.address)) : "";
  const badge =
    alert.test === true
      ? `<span class="badge" title="Wiadomość testowa">Ćwiczenie</span>`
      : "";

  const body = [
    type ? `<p class="alarm-strip__type">${type}</p>` : "",
    address ? `<p class="alarm-strip__addr">${address}</p>` : "",
  ]
    .filter(Boolean)
    .join("");

  const inner =
    body ||
    `<p class="alarm-strip__addr">Brak skróconych danych (typ / adres).</p>`;

  return `<div class="card card--alarm card--alarm-compact">
    <div class="alarm-compact__top">
      <div class="alarm-strip">${inner}</div>
      ${badge ? `<div class="alarm-compact__badge">${badge}</div>` : ""}
    </div>
  </div>`;
}

/** Pierwsza opcja (❌ Nie jadę) — mniejszy priorytet wizualny, zwijana sekcja. */
const DECLINE_OPTION_LINE = ALARM_REACTION_FOLLOWUP_LINES[0];

/** Ikony tylko w UI `/board` — treść wiadomości na Messenger bez zmian. */
function optionPresentation(opt) {
  const L = ALARM_REACTION_FOLLOWUP_LINES;
  const svg = (inner) =>
    `<svg class="option__svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

  if (opt === L[1]) {
    return {
      variant: "soon",
      caption: "Będę za 1–3 min",
      svg: svg(
        `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 12 2 2 4-4"/>`,
      ),
    };
  }
  if (opt === L[2]) {
    return {
      variant: "mid",
      caption: "Będę za 4–6 min",
      svg: svg(
        `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/><path d="M12 2v2"/><path d="M12 22v-2"/>`,
      ),
    };
  }
  if (opt === L[3]) {
    return {
      variant: "late",
      caption: "Mogę być powyżej 7 min",
      svg: svg(
        `<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12 7.59 16.41A2 2 0 0 0 7 17.83V22"/><path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>`,
      ),
    };
  }
  if (opt === L[4]) {
    return {
      variant: "solo",
      caption: "Dojadę sam — weźcie nomex",
      svg: svg(
        `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
      ),
    };
  }
  return {
    variant: "default",
    caption: opt,
    svg: svg(`<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>`),
  };
}

const SVG_DECLINE_SMALL = `<svg class="option-minor__svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`;

function renderOptionArticle(opt, people, roleMap, arrivedSet) {
  if (!people?.length) return "";
  const { variant, caption, svg } = optionPresentation(opt);
  const pills = `<div class="pills">${people
    .map((p) => renderArrivalPill(p.name, false, roleMap, arrivedSet))
    .join("")}</div>`;
  return `<article class="option option--${variant}">
      <h3 class="option__label">
        <span class="option__icon option__icon--${variant}">${svg}</span>
        <span class="option__text">${escHtml(caption)}</span>
      </h3>
      ${pills}
    </article>`;
}

function renderDeclineCompact(data, roleMap, arrivedSet) {
  const opt = DECLINE_OPTION_LINE;
  const people = data.reactionsByOption[opt] || [];
  const n = people.length;
  if (!n) return "";
  const pills = `<div class="pills pills--minor option-minor__pills">${people
    .map((p) => renderArrivalPill(p.name, true, roleMap, arrivedSet))
    .join("")}</div>`;
  return `<div class="option-minor-wrap">
    <div class="option-minor" role="group" aria-label="Nie jadę, ${n} ${n === 1 ? "osoba" : n >= 2 && n <= 4 ? "osoby" : "osób"}">
      <div class="option-minor__row">
        <div class="option-minor__head">
          <span class="option-minor__iconwrap" aria-hidden="true">${SVG_DECLINE_SMALL}</span>
          <span class="option-minor__label">Nie jadę</span>
        </div>
        ${pills}
      </div>
    </div>
  </div>`;
}

/**
 * Kolejność kart na /board (inna niż w Messengerze): najpierw „Dojadę sam…”, potem czasy.
 * Klucze `reactionsByOption` nadal = dokładne linie z alarm-followups.js.
 */
const BOARD_MAIN_DISPLAY_ORDER = [
  ALARM_REACTION_FOLLOWUP_LINES[4],
  ALARM_REACTION_FOLLOWUP_LINES[1],
  ALARM_REACTION_FOLLOWUP_LINES[2],
  ALARM_REACTION_FOLLOWUP_LINES[3],
];

function renderOptionsGrid(data, roleMap, arrivedSet) {
  const chunks = [];
  for (const opt of BOARD_MAIN_DISPLAY_ORDER) {
    const html = renderOptionArticle(
      opt,
      data.reactionsByOption[opt] || [],
      roleMap,
      arrivedSet,
    );
    if (html) chunks.push(html);
  }
  const decline = renderDeclineCompact(data, roleMap, arrivedSet);
  if (decline) chunks.push(decline);
  const inner = chunks.join("");
  const showRemiza =
    inner.trim().length > 0 ||
    (data.activeAlarm &&
      (data.activeAlarm.registeredAt != null ||
        (data.activeAlarm.alert &&
          typeof data.activeAlarm.alert === "object" &&
          data.activeAlarm.alert.incidentId != null)));
  const remiza = showRemiza ? renderRemizaSection(data, roleMap) : "";
  return remiza + inner;
}

function renderChatMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return "";
  const nowMs = Date.now();
  const items = list
    .map((m) => {
      const who = escHtml(m.author);
      const body = escHtml(m.text);
      const timeStr = formatRelativeAgoPl(m.at, nowMs);
      const abs = formatPlDateTime(m.at);
      const tip = escHtml(`${abs} · ${m.author}: ${m.text}`);
      return `<li class="chat-msg" title="${tip}">
        <time class="chat-msg__time" datetime="${escHtml(m.at)}">${escHtml(timeStr)}</time>
        <span class="chat-msg__author">${who}</span>
        <span class="chat-msg__body">${body}</span>
      </li>`;
    })
    .join("");
  return `<section class="section section--messages">
    <ul class="chat-msgs">${items}</ul>
  </section>`;
}

export function renderBoardPage(data, jsonHref, req) {
  const updated = formatPlDateTime(data.lastIngestAt);
  const roleMap = loadFirefighterRoleMap();
  const arrivedList = Array.isArray(data.arrivedNames)
    ? data.arrivedNames
    : getArrivedNamesForPayload(data);
  const arrivedSet = new Set(arrivedList);
  const optionsInner = renderOptionsGrid(data, roleMap, arrivedSet);
  const availabilitySection =
    optionsInner.trim().length > 0
      ? `<section class="section section--availability">
      <div class="options options--stack">${optionsInner}</div>
    </section>`
      : "";
  const alertHtml = renderAlertPanel(data.activeAlarm?.alert);
  const messagesHtml = renderChatMessages(data.chatMessages);
  const basePath =
    (req && typeof req.path === "string" ? req.path : "/board").replace(
      /\/$/,
      "",
    ) || "/board";
  const toggleHref = buildBoardArrivalToggleHref(basePath, req || null);
  const remizaHref = buildBoardRemizaMutationHref(basePath, req || null);
  const pollUrlJson = JSON.stringify(jsonHref);
  const toggleUrlJson = JSON.stringify(toggleHref);
  const remizaUrlJson = JSON.stringify(remizaHref);

  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="color-scheme" content="dark"/>
  <title>Tablica odpowiedzi</title>
  <style>
    :root {
      --bg: #0a0e12;
      --bg-elevated: #111820;
      --surface: #151c26;
      --surface-hover: #1c2633;
      --border: rgba(255,255,255,0.07);
      --text: #eef2f7;
      --text-muted: #8b98a8;
      --accent: #e8a838;
      --accent-dim: rgba(232, 168, 56, 0.14);
      --pill-bg: #243044;
      --radius: 16px;
      --font: "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--font);
      background: radial-gradient(1200px 600px at 80% -10%, rgba(232,168,56,0.08), transparent 55%),
        radial-gradient(800px 400px at -5% 100%, rgba(80,120,200,0.06), transparent 50%),
        var(--bg);
      color: var(--text);
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    .wrap {
      max-width: 880px;
      margin: 0 auto;
      padding: clamp(12px, 3vw, 20px) clamp(16px, 4vw, 28px) 56px;
    }
    .topbar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 12px;
    }
    .meta {
      margin: 0;
      font-size: 0.78rem;
      color: var(--text-muted);
      text-align: right;
    }
    .meta strong { color: var(--text-muted); font-weight: 500; }
    .section { margin-top: 20px; }
    .section__title {
      font-size: 1.05rem;
      font-weight: 600;
      margin: 0 0 16px;
      color: var(--text);
      letter-spacing: -0.01em;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 22px 24px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.25);
    }
    .card--muted {
      background: var(--bg-elevated);
      border-style: dashed;
    }
    .card--alarm {
      border-color: rgba(232,168,56,0.28);
      background: linear-gradient(
        165deg,
        rgba(232, 168, 56, 0.14) 0%,
        rgba(232, 168, 56, 0.04) 38%,
        var(--surface) 72%
      );
    }
    .card--alarm-compact {
      padding: 8px 14px 12px;
    }
    .alarm-compact__top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .alarm-compact__top .alarm-strip {
      flex: 1 1 auto;
      min-width: 0;
      margin: 0;
    }
    .alarm-compact__badge {
      flex: 0 0 auto;
      padding-top: 1px;
    }
    .alarm-strip {
      margin: 0;
    }
    .alarm-strip__type {
      margin: 0 0 4px;
      font-size: 0.92rem;
      font-weight: 600;
      line-height: 1.35;
      color: var(--text);
    }
    .alarm-strip__addr {
      margin: 0;
      font-size: 0.78rem;
      line-height: 1.35;
      color: var(--text-muted);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .card__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
    }
    .card__title { margin: 0; font-size: 1.1rem; font-weight: 600; }
    .badge {
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 5px 10px;
      border-radius: 999px;
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid rgba(232,168,56,0.35);
    }
    .card__lead { margin: 0 0 8px; font-size: 1rem; }
    .card__hint { margin: 0; font-size: 0.88rem; color: var(--text-muted); }
    .options {
      display: grid;
      gap: 14px;
    }
    .options--stack .option-minor-wrap {
      grid-column: 1 / -1;
      margin-top: 4px;
    }
    .option-minor-wrap {
      margin-top: 6px;
    }
    .option-minor {
      border: 1px solid rgba(248, 113, 113, 0.14);
      border-radius: 12px;
      background: linear-gradient(
        145deg,
        rgba(248, 113, 113, 0.08) 0%,
        rgba(0, 0, 0, 0.22) 55%
      );
      padding: 8px 12px;
      overflow: hidden;
    }
    .option-minor__row {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .option-minor__head {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
      font-size: 0.82rem;
      color: var(--text-muted);
    }
    .option-minor__iconwrap {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(248, 113, 113, 0.85);
      opacity: 0.9;
    }
    .option-minor__svg {
      display: block;
      width: 15px;
      height: 15px;
      flex-shrink: 0;
    }
    .option-minor__label { font-weight: 600; color: var(--text-muted); white-space: nowrap; }
    .option-minor__pills {
      flex: 1 1 auto;
      min-width: 0;
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      padding: 2px 0;
    }
    .pills--minor { gap: 6px; }
    .pills--minor .pill {
      padding: 4px 10px;
      font-size: 0.78rem;
    }
    .pills--minor .pill.pill--arrival {
      padding: 7px 13px;
      font-size: 0.92rem;
      font-weight: 600;
    }
    .option {
      position: relative;
      border-radius: var(--radius);
      padding: 18px 20px;
      overflow: hidden;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .option--soon {
      background: linear-gradient(
        145deg,
        rgba(34, 197, 94, 0.28) 0%,
        rgba(34, 197, 94, 0.12) 40%,
        var(--bg-elevated) 70%
      );
      border: 1px solid rgba(74, 222, 128, 0.42);
    }
    .option--soon:hover {
      border-color: rgba(74, 222, 128, 0.55);
      box-shadow: 0 0 0 1px rgba(74, 222, 128, 0.16);
    }
    .option--mid {
      background: linear-gradient(
        145deg,
        rgba(251, 191, 36, 0.26) 0%,
        rgba(251, 191, 36, 0.11) 40%,
        var(--bg-elevated) 70%
      );
      border: 1px solid rgba(251, 191, 36, 0.4);
    }
    .option--mid:hover {
      border-color: rgba(251, 191, 36, 0.55);
      box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.14);
    }
    .option--late {
      background: linear-gradient(
        145deg,
        rgba(96, 165, 250, 0.26) 0%,
        rgba(96, 165, 250, 0.1) 40%,
        var(--bg-elevated) 70%
      );
      border: 1px solid rgba(147, 197, 253, 0.42);
    }
    .option--late:hover {
      border-color: rgba(147, 197, 253, 0.55);
      box-shadow: 0 0 0 1px rgba(147, 197, 253, 0.14);
    }
    .option--default {
      background: linear-gradient(
        145deg,
        rgba(100, 116, 139, 0.1) 0%,
        var(--bg-elevated) 52%
      );
      border: 1px solid var(--border);
    }
    .option--default:hover {
      border-color: rgba(255, 255, 255, 0.12);
      box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.06);
    }
    .option--solo {
      border: 1px solid rgba(252, 165, 165, 0.55);
      background: linear-gradient(
        145deg,
        rgba(239, 68, 68, 0.32) 0%,
        rgba(248, 113, 113, 0.18) 42%,
        var(--bg-elevated) 72%
      );
      animation: soloCardGlow 2.2s ease-in-out infinite;
    }
    .option--solo::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      background: radial-gradient(
        115% 100% at 8% -8%,
        rgba(254, 202, 202, 0.72),
        rgba(239, 68, 68, 0.38) 38%,
        rgba(185, 28, 28, 0.12) 58%,
        transparent 72%
      );
      animation: soloBgPulse 2.2s ease-in-out infinite;
    }
    .option--solo::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      background: radial-gradient(
        95% 85% at 96% 108%,
        rgba(220, 38, 38, 0.55),
        rgba(248, 113, 113, 0.2) 48%,
        transparent 68%
      );
      animation: soloBgPulse 2.2s ease-in-out infinite;
      animation-delay: 1.1s;
    }
    .option--solo:hover {
      border-color: rgba(254, 202, 202, 0.65);
    }
    @keyframes soloBgPulse {
      0%, 100% { opacity: 0.48; }
      50% { opacity: 1; }
    }
    @keyframes soloCardGlow {
      0%, 100% {
        box-shadow:
          0 0 0 1px rgba(248, 113, 113, 0.12),
          0 0 18px -6px rgba(239, 68, 68, 0.35);
      }
      50% {
        box-shadow:
          0 0 0 1px rgba(254, 202, 202, 0.22),
          0 0 36px 2px rgba(239, 68, 68, 0.55),
          0 0 56px 8px rgba(220, 38, 38, 0.22);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .option--solo {
        animation: none;
        box-shadow: 0 0 24px -4px rgba(239, 68, 68, 0.4);
      }
      .option--solo::before,
      .option--solo::after {
        animation: none;
        opacity: 0.72;
      }
    }
    .option--solo .option__label,
    .option--solo .pills {
      position: relative;
      z-index: 1;
    }
    .option--soon:hover,
    .option--mid:hover,
    .option--late:hover,
    .option--default:hover {
      filter: brightness(1.03);
    }
    .option--solo:hover {
      filter: brightness(1.02);
    }
    .option__label {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 14px;
      font-size: 1.2rem;
      font-weight: 600;
      line-height: 1.35;
    }
    .option__icon {
      flex: 0 0 auto;
      width: 1.35em;
      height: 1.35em;
      min-width: 1.35em;
      min-height: 1.35em;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .option__icon .option__svg {
      display: block;
      width: 72%;
      height: 72%;
      max-width: 18px;
      max-height: 18px;
    }
    .option__icon--soon {
      background: rgba(34, 197, 94, 0.12);
      color: #4ade80;
      border-color: rgba(74, 222, 128, 0.25);
    }
    .option__icon--mid {
      background: rgba(251, 191, 36, 0.12);
      color: #fbbf24;
      border-color: rgba(251, 191, 36, 0.28);
    }
    .option__icon--late {
      background: rgba(96, 165, 250, 0.1);
      color: #93c5fd;
      border-color: rgba(147, 197, 253, 0.22);
    }
    .option__icon--solo {
      background: rgba(248, 113, 113, 0.1);
      color: #fca5a5;
      border-color: rgba(252, 165, 165, 0.25);
    }
    .option__icon--default {
      background: var(--pill-bg);
      color: var(--text-muted);
    }
    .option__text {
      flex: 1;
      min-width: 0;
    }
    .pills { display: flex; flex-wrap: wrap; gap: 8px; }
    .pill {
      display: inline-block;
      padding: 7px 14px;
      border-radius: 999px;
      font-size: 0.88rem;
      font-weight: 500;
      background: var(--pill-bg);
      color: var(--text);
      border: 1px solid var(--border);
    }
    .pill__roles {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
    }
    .pill__role {
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      box-sizing: border-box;
      line-height: 0;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0;
      text-align: center;
    }
    .pill__role--d {
      background: rgba(250, 204, 21, 0.22);
      color: #fde047;
      border: 1px solid rgba(250, 204, 21, 0.45);
    }
    .pill__role--k {
      background: rgba(96, 165, 250, 0.22);
      color: #93c5fd;
      border: 1px solid rgba(147, 197, 253, 0.42);
    }
    .pill--arrival--minor .pill__role {
      width: 21px;
      height: 21px;
      font-size: 12.5px;
    }
    .pill--arrival {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      cursor: pointer;
      user-select: none;
      vertical-align: middle;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .pill--arrival:focus-visible {
      outline: 2px solid rgba(232, 168, 56, 0.7);
      outline-offset: 2px;
    }
    .pill__text { min-width: 0; }
    .pill__check {
      display: none;
      flex-shrink: 0;
      width: 1.12em;
      height: 1.12em;
      align-items: center;
      justify-content: center;
      color: #4ade80;
    }
    .pill--arrived .pill__check { display: flex; }
    .pill__check-svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .pill--arrived,
    .option .pills:not(.pills--minor) .pill.pill--arrived,
    .pills--minor .pill.pill--arrived {
      background: rgba(34, 197, 94, 0.32);
      border-color: rgba(74, 222, 128, 0.55);
      color: #ecfdf5;
    }
    .pill--arrival--minor .pill__check {
      width: 1.05em;
      height: 1.05em;
    }
    .option .pills:not(.pills--minor) {
      gap: 10px;
    }
    .option .pills:not(.pills--minor) .pill {
      padding: 13px 22px;
      font-size: 1.14rem;
      font-weight: 600;
    }
    .chat-msgs {
      list-style: none;
      margin: 0;
      padding: 0;
      background: linear-gradient(
        180deg,
        rgba(96, 165, 250, 0.09) 0%,
        var(--surface) 28%
      );
      border: 1px solid rgba(147, 197, 253, 0.16);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .chat-msg {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      min-width: 0;
      font-size: 0.88rem;
      line-height: 1.35;
    }
    .chat-msg:last-child { border-bottom: 0; }
    .chat-msg__time {
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .chat-msg__author {
      flex: 0 1 auto;
      max-width: 34%;
      font-weight: 600;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-msg__body {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text);
    }
    .section--remiza {
      margin-top: 0;
    }
    .remiza {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      align-items: center;
      gap: 10px 14px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 14px 10px 16px;
      min-width: 0;
    }
    .remiza__title {
      margin: 0;
      flex: 0 1 auto;
      min-width: 0;
      font-size: 1rem;
      font-weight: 600;
      color: var(--text);
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .remiza__rolebtns {
      display: flex;
      gap: 10px;
      flex: 0 0 auto;
      margin-left: auto;
    }
    .remiza__counter {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1 1 auto;
      min-width: 0;
      gap: 10px;
    }
    .remiza-num {
      flex: 0 0 auto;
      padding: 13px 16px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--pill-bg);
      color: var(--text);
      font-size: 1.14rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      line-height: 1.2;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .remiza-num:hover {
      background: var(--surface-hover);
      border-color: rgba(255,255,255,0.14);
    }
    .remiza-num:focus-visible {
      outline: 2px solid rgba(232, 168, 56, 0.65);
      outline-offset: 2px;
    }
    .remiza-num--active {
      background: rgba(34, 197, 94, 0.32);
      border-color: rgba(74, 222, 128, 0.55);
      color: #ecfdf5;
    }
    .remiza-num--active:hover {
      background: rgba(34, 197, 94, 0.4);
      border-color: rgba(74, 222, 128, 0.65);
      color: #ecfdf5;
    }
    .remiza-role {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      padding: 13px 22px;
      border-radius: 999px;
      border: 1px solid var(--border);
      cursor: pointer;
      font-size: 1.14rem;
      font-weight: 600;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .remiza-role:focus-visible {
      outline: 2px solid rgba(232, 168, 56, 0.65);
      outline-offset: 2px;
    }
    .remiza-role--off {
      background: var(--pill-bg);
      color: var(--text-muted);
      border-color: rgba(248, 113, 113, 0.35);
    }
    .remiza-role__zero {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      font-size: 14px;
      font-weight: 800;
      color: #fecaca;
      background: rgba(185, 28, 28, 0.35);
      border: 1px solid rgba(248, 113, 113, 0.45);
    }
    .remiza-role--on {
      background: rgba(34, 197, 94, 0.32);
      color: #ecfdf5;
      border-color: rgba(74, 222, 128, 0.55);
    }
    .remiza-role__iconwrap {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      flex-shrink: 0;
    }
    .remiza-role__svg {
      width: 22px;
      height: 22px;
      display: block;
    }
    .remiza-role__svg--check {
      color: #4ade80;
    }
    .remiza-role__label {
      white-space: nowrap;
    }
    footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      text-align: center;
    }
    footer a {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-decoration: none;
    }
    footer a:hover { color: var(--accent); }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar">
      <p class="meta">Aktualizacja: ${escHtml(updated)}</p>
    </header>

    ${alertHtml}

    ${availabilitySection}

    ${messagesHtml}

    <footer>
      <a href="${escHtml(jsonHref)}">Eksport danych (JSON)</a>
    </footer>
  </div>
  <script>
(function () {
  var pollUrl = ${pollUrlJson};
  var toggleUrl = ${toggleUrlJson};
  var remizaUrl = ${remizaUrlJson};
  var POLL_MS = 4000;
  function applyRemiza(r) {
    if (!r || typeof r !== "object") return;
    var hc = r.headcount != null ? Number(r.headcount) : 0;
    document.querySelectorAll("[data-remiza-headcount]").forEach(function (btn) {
      var v = parseInt(btn.getAttribute("data-remiza-headcount"), 10);
      if (isNaN(v)) return;
      var on = hc === v;
      btn.classList.toggle("remiza-num--active", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    });
    function setRole(sel, on) {
      var btn = document.querySelector(sel);
      if (!btn) return;
      btn.classList.toggle("remiza-role--on", !!on);
      btn.classList.toggle("remiza-role--off", !on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      var wrap = btn.querySelector(".remiza-role__iconwrap");
      if (!wrap) return;
      if (on) {
        wrap.innerHTML = ${JSON.stringify(REMIZA_CHECK_SVG)};
      } else {
        wrap.innerHTML = '<span class="remiza-role__zero" aria-hidden="true">0</span>';
      }
    }
    setRole('[data-remiza-role="dowodca"]', r.dowodca);
    setRole('[data-remiza-role="kierowca"]', r.kierowca);
  }
  function applyArrived(arr) {
    var set = new Set(Array.isArray(arr) ? arr : []);
    document.querySelectorAll("[data-arrival-name]").forEach(function (el) {
      var n = el.getAttribute("data-arrival-name");
      if (n == null) return;
      var on = set.has(n);
      el.classList.toggle("pill--arrived", on);
      el.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  function poll() {
    fetch(pollUrl, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j && Array.isArray(j.arrivedNames)) applyArrived(j.arrivedNames);
        if (j && j.remiza) applyRemiza(j.remiza);
      })
      .catch(function () {});
  }
  function toggle(name) {
    fetch(toggleUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j && j.ok && Array.isArray(j.arrivedNames)) applyArrived(j.arrivedNames);
        if (j && j.ok && j.remiza) applyRemiza(j.remiza);
        if (!j || !j.ok) poll();
      })
      .catch(function () {
        poll();
      });
  }
  var root = document.querySelector(".wrap");
  if (!root) return;
  function postRemiza(body) {
    fetch(remizaUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j && j.ok && j.remiza) applyRemiza(j.remiza);
        else poll();
      })
      .catch(function () {
        poll();
      });
  }
  poll();
  setInterval(poll, POLL_MS);
  root.addEventListener("click", function (e) {
    var hBtn = e.target.closest("[data-remiza-headcount]");
    if (hBtn && root.contains(hBtn)) {
      e.preventDefault();
      var hv = parseInt(hBtn.getAttribute("data-remiza-headcount"), 10);
      if (hv >= 1 && hv <= 6) postRemiza({ op: "headcount", value: hv });
      return;
    }
    var rBtn = e.target.closest("[data-remiza-role]");
    if (rBtn && root.contains(rBtn)) {
      e.preventDefault();
      var role = rBtn.getAttribute("data-remiza-role");
      if (role === "dowodca" || role === "kierowca") postRemiza({ op: "role", role: role });
      return;
    }
    var pill = e.target.closest("[data-arrival-name]");
    if (!pill || !root.contains(pill)) return;
    e.preventDefault();
    toggle(pill.getAttribute("data-arrival-name"));
  });
  root.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var hBtn = e.target.closest("[data-remiza-headcount]");
    if (hBtn && root.contains(hBtn)) {
      e.preventDefault();
      var hv = parseInt(hBtn.getAttribute("data-remiza-headcount"), 10);
      if (hv >= 1 && hv <= 6) postRemiza({ op: "headcount", value: hv });
      return;
    }
    var rBtn = e.target.closest("[data-remiza-role]");
    if (rBtn && root.contains(rBtn)) {
      e.preventDefault();
      var role = rBtn.getAttribute("data-remiza-role");
      if (role === "dowodca" || role === "kierowca") postRemiza({ op: "role", role: role });
      return;
    }
    var pill = e.target.closest("[data-arrival-name]");
    if (!pill || e.target !== pill || !root.contains(pill)) return;
    e.preventDefault();
    toggle(pill.getAttribute("data-arrival-name"));
  });
})();
  </script>
</body>
</html>`;
}

export function mountBoardRoutes(app) {
  resetBoard();

  const arrivalToggleHandler = (req, res) => {
    const name =
      typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ ok: false, error: "Brak pola name" });
      return;
    }
    try {
      const data = resolveBoardDataForArrivalKey(req);
      const arrivedNames = toggleArrivalForData(name, data);
      const remiza = buildRemizaPayloadForData({ ...data, arrivedNames });
      res.json({ ok: true, arrivedNames, remiza });
    } catch (e) {
      res
        .status(500)
        .json({ ok: false, error: e?.message ? String(e.message) : String(e) });
    }
  };

  const jsonHandler = (req, res) => {
    let data = getBoardPayload();
    if (isDemoQuery(req)) {
      const demo = loadDemoBoardPayload();
      if (demo) data = demo;
    }
    res.json(mergeArrivedNamesIntoPayload(data));
  };

  const htmlHandler = (req, res) => {
    if (req.query.format === "json") {
      let data = getBoardPayload();
      if (isDemoQuery(req)) {
        const demo = loadDemoBoardPayload();
        if (demo) data = demo;
      }
      res.json(mergeArrivedNamesIntoPayload(data));
      return;
    }
    let data = getBoardPayload();
    if (isDemoQuery(req)) {
      const demo = loadDemoBoardPayload();
      if (demo) data = demo;
    }
    data = mergeArrivedNamesIntoPayload(data);
    const secQ = req.query.secret
      ? `?secret=${encodeURIComponent(String(req.query.secret))}`
      : "";
    const basePath = req.path.replace(/\/$/, "") || "/messenger/board";
    const jsonHref = boardJsonHrefWithDemo(basePath, secQ, req);

    res.status(200).type("html").send(renderBoardPage(data, jsonHref, req));
  };

  const jsonPaths = [
    "/messenger/board.json",
    "/messenger/board.json/",
    "/board.json",
    "/board.json/",
  ];
  const htmlPaths = [
    "/messenger/board",
    "/messenger/board/",
    "/board",
    "/board/",
  ];

  for (const p of jsonPaths) {
    app.get(p, boardAuthMiddleware, jsonHandler);
  }
  for (const p of htmlPaths) {
    app.get(p, boardAuthMiddleware, htmlHandler);
  }

  const arrivalTogglePaths = [
    "/board/arrival/toggle",
    "/board/arrival/toggle/",
    "/messenger/board/arrival/toggle",
    "/messenger/board/arrival/toggle/",
  ];
  for (const p of arrivalTogglePaths) {
    app.post(p, boardAuthMiddleware, arrivalToggleHandler);
  }

  const remizaMutationHandler = (req, res) => {
    const op = req.body?.op;
    try {
      const data = resolveBoardDataForArrivalKey(req);
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

  const remizaPaths = [
    "/board/remiza",
    "/board/remiza/",
    "/messenger/board/remiza",
    "/messenger/board/remiza/",
  ];
  for (const p of remizaPaths) {
    app.post(p, boardAuthMiddleware, remizaMutationHandler);
  }

  if (isBoardSnapshotSyncEnabled()) {
    void writeBoardSnapshotNow().catch(() => {});
  }

  console.log(
    "[board] zarejestrowano trasy: /messenger/board, /board (+ .json, POST …/arrival/toggle, …/remiza)" +
      (isBoardSnapshotSyncEnabled()
        ? ` · snapshot → ${boardSnapshotPath()} (BOARD_SNAPSHOT_SYNC)`
        : ""),
  );
}
