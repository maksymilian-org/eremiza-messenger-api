import path from "path";
import puppeteer from "puppeteer";
import {
  fetchLatestAlertApibeta,
  isApibetaDisabled,
  isSameEremizaAsGist,
  keepAliveApibetaTick,
  tryApibetaBeforeChromium,
  useApibetaEremiza,
} from "./eremiza-apibeta.js";
import { convertCoorsFromERemizaToDecimal, waitForTimeout } from "./utils.js";

export {
  isApibetaDisabled,
  isSameEremizaAsGist,
  tryApibetaBeforeChromium,
  useApibetaEremiza,
} from "./eremiza-apibeta.js";

const LOGIN_PAGE_URL = "https://e-remiza.pl/OSP.UI.SSO/logowanie";
const ALERTS_PAGE_URL = "https://e-remiza.pl/OSP.UI.EREMIZA/alarmy";

/** Domyślnie 9 min — sesja e-Remiza ~10 min, odświeżamy wcześniej. */
const SESSION_REFRESH_MS =
  Number(process.env.EREMIZA_SESSION_REFRESH_MS) || 9 * 60 * 1000;

/** Gdy tabela = Gist: odświeżanie strony alarmów i szukanie nowego wiersza. */
const POLL_INTERVAL_MS =
  Number(process.env.EREMIZA_POLL_INTERVAL_MS) || 5000;
const POLL_MAX_MS = Number(process.env.EREMIZA_POLL_MAX_MS) || 2 * 60 * 1000;

function eremizaProfileDir() {
  return (
    process.env.EREMIZA_USER_DATA_DIR?.trim() ||
    path.join(process.cwd(), ".data", "puppeteer-eremiza")
  );
}

function eremizaHeadlessOption() {
  const v = process.env.EREMIZA_HEADLESS?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  return "shell";
}

/** Kolejka — jedno sprawdzenie naraz (współdzielona przeglądarka). */
const eremizaLock = {
  _tail: Promise.resolve(),
  run(fn) {
    const result = this._tail.then(() => fn());
    this._tail = result.catch(() => {});
    return result;
  },
};

let browser = null;
let page = null;
/** Czas udanego logowania (ms); po przekroczeniu SESSION_REFRESH_MS — ponowne logowanie. */
let lastLoginAt = null;

async function ensureBrowser() {
  if (browser?.isConnected?.()) return;

  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ok */
    }
  }

  browser = null;
  page = null;
  lastLoginAt = null;

  console.log("e-Remiza: start Chromium (profil:", eremizaProfileDir(), ")…");
  browser = await puppeteer.launch({
    headless: eremizaHeadlessOption(),
    timeout: 60000,
    args: ["--no-sandbox"],
    userDataDir: eremizaProfileDir(),
  });
  page = await browser.newPage();
}

async function loginToERemiza() {
  const LOGIN = process.env.EREMIZA_LOGIN;
  const PASSWORD = process.env.EREMIZA_PASSWORD;

  await page.goto(LOGIN_PAGE_URL, { waitUntil: "load", timeout: 90000 });

  await page.waitForSelector(
    "#ContentPlaceHolder1_ASPxCallbackPanelLogin_ASPxTextBoxUserName_I",
    { timeout: 30000 }
  );
  await page.type(
    "#ContentPlaceHolder1_ASPxCallbackPanelLogin_ASPxTextBoxUserName_I",
    LOGIN
  );
  await page.type(
    "#ContentPlaceHolder1_ASPxCallbackPanelLogin_ASPxTextBoxPassword_I",
    PASSWORD
  );
  await page.click("#ContentPlaceHolder1_ASPxButtonLogin");
  await page.waitForNavigation({ waitUntil: "load", timeout: 90000 }).catch(() => {});
}

async function readLastAlertFromPage() {
  await page.goto(ALERTS_PAGE_URL, { waitUntil: "load", timeout: 90000 });

  const url = page.url();
  if (url.includes("logowanie") || url.includes("SSO")) {
    throw new Error("e-Remiza: przekierowanie na logowanie — sesja wygasła.");
  }

  await page.waitForSelector("#MainContent_ASPxGridViewAlarms_DXMainTable", {
    timeout: 30000,
  });

  const alert = await page.$$eval(
    "#MainContent_ASPxGridViewAlarms_DXDataRow0 td",
    (anchors) => {
      return anchors.map((anchor) => {
        if (anchor.id === "MainContent_ASPxGridViewAlarms_tccell0_3") {
          return anchor?.getElementsByTagName("span")[0].title?.trim();
        }
        return anchor?.textContent?.trim();
      });
    }
  );

  const [date, type, address, description, _, author, coords] = alert;

  return {
    date,
    type,
    address,
    description,
    author,
    coords: convertCoorsFromERemizaToDecimal(coords),
  };
}

function logApibetaOk(row) {
  if (row?.date) {
    console.log(
      "e-Remiza: odczyt OK — źródło: API beta (apibeta.e-remiza.pl), ostatni alarm:",
      row.date
    );
  } else {
    console.log(
      "e-Remiza: odczyt OK — źródło: API beta, brak alarmów w oknie dat (lista pusta)."
    );
  }
}

async function getLastAlertBody() {
  console.time("e-Remiza checking");
  try {
    if (useApibetaEremiza()) {
      console.log(
        "e-Remiza: tryb EREMIZA_USE_APIBETA — wyłącznie API beta (bez Chromium)."
      );
      const row = await fetchLatestAlertApibeta();
      logApibetaOk(row);
      return row;
    }

    if (tryApibetaBeforeChromium()) {
      try {
        const row = await fetchLatestAlertApibeta();
        logApibetaOk(row);
        return row;
      } catch (err) {
        console.warn(
          "e-Remiza: API beta niepowodzenie — fallback Chromium (/alarmy):",
          err?.message
        );
      }
    } else {
      console.log(
        "e-Remiza: EREMIZA_APIBETA_DISABLED — pomijam API beta, tylko Chromium."
      );
    }

    await ensureBrowser();

    const stale =
      lastLoginAt == null ||
      Date.now() - lastLoginAt >= SESSION_REFRESH_MS;

    if (stale) {
      console.log(
        `e-Remiza: Chromium — logowanie (sesja > ${Math.round(SESSION_REFRESH_MS / 60000)} min lub pierwszy start)…`
      );
      await loginToERemiza();
      lastLoginAt = Date.now();
    } else {
      console.log(
        "e-Remiza: Chromium — ponowne użycie sesji (ostatnie logowanie < limit odświeżania)."
      );
    }

    try {
      const row = await readLastAlertFromPage();
      console.log(
        "e-Remiza: odczyt OK — źródło: Chromium (e-remiza.pl /alarmy), ostatni alarm:",
        row?.date
      );
      return row;
    } catch (err) {
      console.warn(
        "e-Remiza: Chromium — błąd odczytu, ponowne logowanie:",
        err?.message
      );
      await loginToERemiza();
      lastLoginAt = Date.now();
      const row = await readLastAlertFromPage();
      console.log(
        "e-Remiza: odczyt OK — źródło: Chromium (po ponownym logowaniu), ostatni alarm:",
        row?.date
      );
      return row;
    }
  } finally {
    console.timeEnd("e-Remiza checking");
  }
}

export const getLastAlert = () => eremizaLock.run(() => getLastAlertBody());

async function readLastAlertChromiumPoll() {
  await ensureBrowser();
  const stale =
    lastLoginAt == null || Date.now() - lastLoginAt >= SESSION_REFRESH_MS;
  if (stale) {
    console.log("e-Remiza: Chromium — logowanie przed odczytem (polling)…");
    await loginToERemiza();
    lastLoginAt = Date.now();
  }
  try {
    return await readLastAlertFromPage();
  } catch (err) {
    console.warn(
      "e-Remiza: Chromium — błąd podczas pollingu, ponowne logowanie:",
      err?.message
    );
    await loginToERemiza();
    lastLoginAt = Date.now();
    return await readLastAlertFromPage();
  }
}

/**
 * Gdy ostatni odczyt = Gist — przez max POLL_MAX_MS co POLL_INTERVAL_MS
 * ponownie czyta alarmy (API beta i/lub Chromium).
 */
async function pollForNewAlertBody(gist) {
  const gistDate = gist?.date;
  if (!gistDate && gist?.incidentId == null) return null;

  if (useApibetaEremiza()) {
    const started = Date.now();
    console.log(
      `e-Remiza: polling tylko API beta — co ${POLL_INTERVAL_MS / 1000}s (max ${POLL_MAX_MS / 1000}s)…`
    );
    while (Date.now() - started < POLL_MAX_MS) {
      await waitForTimeout(POLL_INTERVAL_MS);
      let row;
      try {
        row = await fetchLatestAlertApibeta();
      } catch (err) {
        console.warn("e-Remiza: polling API beta — błąd:", err?.message);
        continue;
      }
      if (row && !isSameEremizaAsGist(row, gist)) {
        console.log(
          "e-Remiza: nowy alarm w pollingu — źródło: API beta."
        );
        return row;
      }
    }
    return null;
  }

  const chromiumOnly = isApibetaDisabled();
  let useChromium = chromiumOnly;
  const started = Date.now();
  console.log(
    chromiumOnly
      ? `e-Remiza: polling — tylko Chromium, co ${POLL_INTERVAL_MS / 1000}s (max ${POLL_MAX_MS / 1000}s)…`
      : `e-Remiza: polling — najpierw API beta, przy błędzie Chromium; co ${POLL_INTERVAL_MS / 1000}s (max ${POLL_MAX_MS / 1000}s)…`
  );

  while (Date.now() - started < POLL_MAX_MS) {
    await waitForTimeout(POLL_INTERVAL_MS);
    let row;

    if (!useChromium) {
      try {
        row = await fetchLatestAlertApibeta();
      } catch (err) {
        console.warn(
          "e-Remiza: polling — API beta błąd, dalszy polling przez Chromium:",
          err?.message
        );
        useChromium = true;
      }
    }

    if (useChromium) {
      row = await readLastAlertChromiumPoll();
    }

    if (row && !isSameEremizaAsGist(row, gist)) {
      console.log(
        `e-Remiza: nowy alarm w pollingu — źródło: ${useChromium ? "Chromium" : "API beta"}.`
      );
      return row;
    }
  }
  return null;
}

export const pollEremizaForNewAlert = (gist) =>
  eremizaLock.run(() => pollForNewAlertBody(gist));

async function chromiumKeepAliveShape() {
  const s = {
    source: "chromium",
    browserOk: false,
    pageOk: false,
    jsOk: false,
  };
  try {
    s.browserOk = Boolean(browser?.isConnected?.());
    s.pageOk = Boolean(page);
    if (s.browserOk && page) {
      const v = await page.evaluate(() => 1).catch(() => null);
      s.jsOk = v === 1;
    }
  } catch {
    /* ok */
  }
  return s;
}

/** Ping sesji e-Remiza: tryb hybrydowy sprawdza API + zapas Chromium. */
export const keepAliveEremizaTick = () =>
  eremizaLock.run(async () => {
    if (useApibetaEremiza()) {
      return keepAliveApibetaTick();
    }
    if (isApibetaDisabled()) {
      return chromiumKeepAliveShape();
    }
    const api = await keepAliveApibetaTick().catch(() => ({
      source: "apibeta",
      sessionOk: false,
      apiOk: false,
    }));
    const cr = await chromiumKeepAliveShape();
    return {
      source: "hybrid",
      apiSessionOk: api.sessionOk,
      apiOk: api.apiOk,
      browserOk: cr.browserOk,
      pageOk: cr.pageOk,
      jsOk: cr.jsOk,
    };
  });

/** Rozgrzewka przy starcie serwera (to samo co pierwsze pobranie alarmu). */
export const warmupERemiza = () => eremizaLock.run(() => getLastAlertBody());
