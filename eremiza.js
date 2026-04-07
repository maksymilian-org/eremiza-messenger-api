import path from "path";
import puppeteer from "puppeteer";
import { convertCoorsFromERemizaToDecimal, waitForTimeout } from "./utils.js";

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

async function getLastAlertBody() {
  console.time("e-Remiza checking");
  try {
    await ensureBrowser();

    const stale =
      lastLoginAt == null ||
      Date.now() - lastLoginAt >= SESSION_REFRESH_MS;

    if (stale) {
      console.log(
        `e-Remiza: logowanie (sesja > ${Math.round(SESSION_REFRESH_MS / 60000)} min lub pierwszy start)…`
      );
      await loginToERemiza();
      lastLoginAt = Date.now();
    } else {
      console.log(
        "e-Remiza: ponowne użycie sesji (ostatnie logowanie < limit odświeżania)."
      );
    }

    try {
      return await readLastAlertFromPage();
    } catch (err) {
      console.warn("e-Remiza: błąd odczytu alarmów — ponowne logowanie:", err?.message);
      await loginToERemiza();
      lastLoginAt = Date.now();
      return await readLastAlertFromPage();
    }
  } finally {
    console.timeEnd("e-Remiza checking");
  }
}

export const getLastAlert = () => eremizaLock.run(() => getLastAlertBody());

/**
 * Gdy ostatni wiersz tabeli ma ten sam `date` co Gist — przez max POLL_MAX_MS
 * co POLL_INTERVAL_MS ponownie ładuje stronę alarmów i czyta pierwszy wiersz.
 * Zwraca alarm z innym `date` albo `null`, jeśli nadal bez zmian.
 */
async function pollForNewAlertBody(gistDate) {
  if (!gistDate) return null;

  await ensureBrowser();

  const stale =
    lastLoginAt == null || Date.now() - lastLoginAt >= SESSION_REFRESH_MS;
  if (stale) {
    console.log("e-Remiza: logowanie przed pollingiem tabeli…");
    await loginToERemiza();
    lastLoginAt = Date.now();
  }

  const started = Date.now();
  console.log(
    `e-Remiza: brak nowego vs Gist — polling tabeli co ${POLL_INTERVAL_MS / 1000}s (max ${POLL_MAX_MS / 1000}s)…`
  );

  while (Date.now() - started < POLL_MAX_MS) {
    await waitForTimeout(POLL_INTERVAL_MS);
    let row;
    try {
      row = await readLastAlertFromPage();
    } catch (err) {
      console.warn("e-Remiza: błąd podczas pollingu — ponowne logowanie:", err?.message);
      await loginToERemiza();
      lastLoginAt = Date.now();
      row = await readLastAlertFromPage();
    }
    if (row?.date && row.date !== gistDate) {
      console.log("e-Remiza: nowy alarm pojawił się w tabeli podczas pollingu.");
      return row;
    }
  }
  return null;
}

export const pollEremizaForNewAlert = (gistDate) =>
  eremizaLock.run(() => pollForNewAlertBody(gistDate));

/** Lekki ping Chromium e-Remiza + status do logów keep-alive. */
export const keepAliveEremizaTick = () =>
  eremizaLock.run(async () => {
    const s = {
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
  });

/** Rozgrzewka przy starcie serwera (to samo co pierwsze pobranie alarmu). */
export const warmupERemiza = () => eremizaLock.run(() => getLastAlertBody());
