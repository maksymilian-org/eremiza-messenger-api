import path from "path";
import puppeteer from "puppeteer";
import {
  messengerDebugEnabled,
  saveMessengerDebugSnapshot,
} from "./messenger-debug.js";
import { waitForTimeout } from "./utils.js";

const LOGIN_EMAIL_SELECTORS = [
  "#email",
  'input[name="email"][type="email"]',
  'input[name="email"]',
  'input[type="email"]',
];

const LOGIN_PASS_SELECTORS = [
  "#pass",
  'input[name="pass"][type="password"]',
];

/** Nowy UI Facebook (Comet): przycisk to często `div[role="button"]` z aria-label — nie ma #loginbutton. */
const LOGIN_BUTTON_SELECTORS = [
  'div[role="button"][aria-label="Zaloguj się"]',
  'div[role="button"][aria-label="Log in"]',
  '[aria-label="Zaloguj się"]',
  '[aria-label="Log in"]',
  "#loginbutton",
  'button[name="login"]',
  'button[type="submit"]',
  'input[type="submit"][value="Log In"]',
  'input[type="submit"][value="Zaloguj się"]',
];

/** Baner cookies Meta — często `aria-label`, nie `data-cookiebanner`. */
const COOKIE_ACCEPT_SELECTORS = [
  '[data-cookiebanner="accept_button"]',
  '[aria-label="Zezwól na wszystkie pliki cookie"]',
  '[aria-label="Allow all cookies"]',
  '[aria-label="Accept all cookies"]',
  '[aria-label="Accept all"]',
  '[aria-label*="wszystkie pliki cookie"]',
  '[aria-label*="Allow all"]',
];

const COOKIE_ACCEPT_TEXT_FRAGMENTS = [
  "Zezwól na wszystkie pliki cookie",
  "Allow all cookies",
  "Accept all cookies",
  "Zaakceptuj wszystkie",
  "Akceptuj wszystkie pliki cookie",
];

/** Dokładne etykiety przycisku „wszystkie cookies” (Comet). */
const COOKIE_ALLOW_ARIA_EXACT = [
  "Zezwól na wszystkie pliki cookie",
  "Allow all cookies",
  "Accept all cookies",
];

/** Comet ma dwa węzły z tym samym aria-label — tylko jeden jest klikalny (drugi: aria-disabled + tabindex=-1). */
function escapeAttrForCssSelector(value) {
  const s = String(value);
  if (typeof globalThis.CSS?.escape === "function") {
    return globalThis.CSS.escape(s);
  }
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function messengerProfileDir() {
  return (
    process.env.MESSENGER_USER_DATA_DIR?.trim() ||
    path.join(process.cwd(), ".data", "puppeteer-messenger")
  );
}

/** `false` = okno przeglądarki (2FA / kod z maila — jednorazowo). Domyślnie headless. */
function messengerHeadlessOption() {
  const v = process.env.MESSENGER_HEADLESS?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  return "shell";
}

function conversationPathMatches(currentUrl, targetUrl) {
  try {
    const t = new URL(targetUrl).pathname.replace(/\/$/, "");
    return t.length > 1 && currentUrl.replace(/\/$/, "").includes(t);
  } catch {
    return true;
  }
}

/** Kolejność: najpierw wąskie selektory — ogólne contenteditable łatwo trafiają w wyszukiwarkę zamiast czatu. */
const COMPOSER_SELECTOR_CANDIDATES = [
  '[aria-label="Thread composer"] p',
  '[data-testid="chat-composer-input"]',
  '[aria-label="Message"][role="textbox"]',
  '[aria-label="Message"] div[contenteditable="true"]',
  'div[aria-multiline="true"][contenteditable="true"]',
  '[placeholder="Write a message…"]',
  '[placeholder="Napisz wiadomość…"]',
  '[placeholder="Aa"]',
  'div[role="textbox"][contenteditable="true"]',
];

const SEND_BUTTON_CANDIDATES = [
  '[aria-label="Press enter to send"]',
  '[aria-label="Send"]',
  'div[aria-label="Send"][role="button"]',
];

const LIKE_CONFIRM_CANDIDATES = [
  '[aria-label="Send a Like"]',
  '[aria-label="Like"]',
];

/** Bez wymuszonego długiego czekania na przycisk Like po pierwszej wiadomości (przyspieszenie wpisywania) */
const POST_SEND_STABILIZE_FOLLOW_MS = 600;

export class Messenger {
  browser = null;
  page = null;
  /** Ramka z właściwym UI czatu (Messenger często w iframe — inaczej Puppeteer zgłasza błąd „JavaScript world”). */
  chatFrame = null;
  /** Który selektor zadziałał dla kompozytora (sendMessages musi użyć tego samego). */
  composerSelector = null;
  pageMap = null;

  /** Zapobiega dwóm równoległym `puppeteer.launch` na tym samym `userDataDir`. */
  _launchSingleton = null;

  /** Katalog sesji debug (MESSENGER_DEBUG=1): `.data/messenger-debug/<runId>/`. */
  _debugRunId = null;

  constructor() {}

  async _debugSnap(step) {
    if (!messengerDebugEnabled() || !this.page) return;
    if (!this._debugRunId) {
      this._debugRunId = new Date().toISOString().replace(/[:.]/g, "-");
    }
    await saveMessengerDebugSnapshot(this.page, this._debugRunId, step);
  }

  async _pickSelector(selectors, timeoutEach = 2500) {
    for (const sel of selectors) {
      const el = await this.page
        .waitForSelector(sel, { timeout: timeoutEach, visible: true })
        .catch(() => null);
      if (el) return sel;
    }
    return null;
  }

  async _safeClickHandle(handle) {
    if (!handle) return false;
    try {
      await handle.scrollIntoViewIfNeeded();
    } catch {
      /* ok */
    }
    try {
      await handle.click({ delay: 50, force: true });
      return true;
    } catch {
      try {
        await handle.evaluate((el) => el.click());
        return true;
      } catch {
        return false;
      }
    }
  }

  /** Meta duplikuje przyciski RWD — pomijamy sztucznie wyłączone kopie. */
  async _isMetaCookieButtonClickable(handle) {
    return handle.evaluate((el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.getAttribute("aria-disabled") === "true") return false;
      if (el.getAttribute("tabindex") === "-1") return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      return true;
    });
  }

  /**
   * Wszystkie dopasowania aria-label — klik pierwszego faktycznie aktywnego.
   */
  async _clickEnabledByAriaLabel(frame, label) {
    const sel = `[aria-label="${escapeAttrForCssSelector(label)}"]`;
    const handles = await frame.$$(sel).catch(() => []);
    for (const h of handles) {
      if (await this._isMetaCookieButtonClickable(h)) {
        if (await this._safeClickHandle(h)) return true;
      }
    }
    return false;
  }

  /**
   * Próbuje kliknąć „Zezwól / Allow all…” w jednej ramce (bez „Decline / Odrzuć opcjonalne”).
   */
  async _tryClickCookieAllowInFrame(frame) {
    const custom = process.env.MESSENGER_COOKIE_ACCEPT_SELECTOR?.trim();
    if (custom) {
      let handles = await frame.$$(custom).catch(() => []);
      if (handles.length === 0) {
        const one = await frame.$(custom).catch(() => null);
        if (one) handles = [one];
      }
      for (const h of handles) {
        if (await this._isMetaCookieButtonClickable(h)) {
          if (await this._safeClickHandle(h)) return true;
        }
      }
    }

    for (const lab of COOKIE_ALLOW_ARIA_EXACT) {
      if (await this._clickEnabledByAriaLabel(frame, lab)) return true;
    }

    for (const sel of COOKIE_ACCEPT_SELECTORS) {
      const handles = await frame.$$(sel).catch(() => []);
      for (const h of handles) {
        if (await this._isMetaCookieButtonClickable(h)) {
          if (await this._safeClickHandle(h)) return true;
        }
      }
    }

    return frame.evaluate(() => {
      const rejectAl = (al) =>
        /odrzuć|opcjonalne|decline\s+optional|reject\s+optional|only\s+necessary|tylko\s+niezb/i.test(
          al,
        );
      const allowAl = (al) => {
        const x = al.toLowerCase();
        return (
          (x.includes("zezw") &&
            x.includes("wszystkie") &&
            x.includes("cookie")) ||
          x.includes("allow all cookies") ||
          x.includes("accept all cookies")
        );
      };
      const nodes = document.querySelectorAll(
        '[role="button"],button,div[role="button"],span[role="button"],[aria-label]',
      );
      for (const el of nodes) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.getAttribute("aria-disabled") === "true") continue;
        if (el.getAttribute("tabindex") === "-1") continue;
        const al = (el.getAttribute("aria-label") || "").trim();
        if (!al || rejectAl(al)) continue;
        if (allowAl(al)) {
          el.click();
          return true;
        }
      }
      return false;
    });
  }

  cookieBannerStillVisibleProbe() {
    return this.page.evaluate(() => {
      const markers = [
        "Zezwól na wszystkie pliki cookie",
        "Odrzuć opcjonalne pliki cookie",
        "Allow all cookies",
        "Decline optional cookies",
        "Reject optional cookies",
      ];
      const isLiveControl = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.getAttribute("aria-disabled") === "true") return false;
        if (el.getAttribute("tabindex") === "-1") return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      for (const t of markers) {
        for (const el of document.querySelectorAll(`[aria-label="${t}"]`)) {
          if (isLiveControl(el)) return true;
        }
      }
      return false;
    });
  }

  /**
   * Baner cookies Meta — wszystkie ramki, force click, wiele przejść (dialog często wchodzi po opóźnieniu).
   */
  async _dismissCookieBanner() {
    if (!this.page) return;

    let totalClicks = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt > 0) await waitForTimeout(1100);

      let roundClick = false;
      const frames = this.page.frames();
      for (const fr of frames) {
        try {
          if (await this._tryClickCookieAllowInFrame(fr)) {
            roundClick = true;
            totalClicks++;
            await waitForTimeout(400);
          }
        } catch {
          /* następna ramka */
        }
      }

      if (roundClick) {
        await waitForTimeout(700);
      }

      let still;
      try {
        still = await this.cookieBannerStillVisibleProbe();
      } catch {
        still = false;
      }
      if (!still) break;
    }

    if (totalClicks > 0) {
      console.log(
        `Messenger: kliknięto akceptację plików cookie (${totalClicks}×).`,
      );
    }
  }

  composerCandidates() {
    const one = process.env.MESSENGER_COMPOSER_SELECTOR?.trim();
    if (one) return [one, ...COMPOSER_SELECTOR_CANDIDATES];
    return COMPOSER_SELECTOR_CANDIDATES;
  }

  /**
   * Szuka pierwszej ramki (w tym głównej), w której widać pole kompozytora — próbuje wielu selektorów.
   */
  async waitForChatFrame(totalTimeoutMs = 180000) {
    const selectors = this.composerCandidates();
    const deadline = Date.now() + totalTimeoutMs;
    while (Date.now() < deadline) {
      const frames = this.page.frames();
      for (const frame of frames) {
        for (const selector of selectors) {
          try {
            await frame.waitForSelector(selector, {
              timeout: 600,
              visible: true,
            });
            this.composerSelector = selector;
            return frame;
          } catch {
            // inna kombinacja ramka + selektor
          }
        }
      }
      await waitForTimeout(500);
    }
    const url = this.page.url();
    await this._debugSnap("waitForChatFrame-timeout");
    throw new Error(
      `Timeout: nie znaleziono pola wiadomości (próbowano ${selectors.length} selektorów). URL strony: ${url}. Ustaw MESSENGER_COMPOSER_SELECTOR z DevTools, jeśli UI się zmienił.`
    );
  }

  async waitForSelectorInContext(ctx, candidates, options = {}) {
    const { timeout = 30000 } = options;
    const deadline = Date.now() + timeout;
    let lastErr;
    while (Date.now() < deadline) {
      for (const sel of candidates) {
        try {
          await ctx.waitForSelector(sel, {
            timeout: 800,
            visible: true,
          });
          return sel;
        } catch (e) {
          lastErr = e;
        }
      }
      await waitForTimeout(200);
    }
    throw lastErr ?? new Error("waitForSelectorInContext: timeout");
  }

  context() {
    return this.chatFrame ?? this.page;
  }

  /**
   * Przy starcie serwera — to samo co launchBrowser (logowanie + kompozytor, profil na dysku).
   */
  async warmup() {
    return this.launchBrowser();
  }

  async launchBrowser() {
    this._launchSingleton ??= this._launchBrowserOnce().finally(() => {
      this._launchSingleton = null;
    });
    await this._launchSingleton;
  }

  async _launchBrowserOnce() {
    const targetUrl = process.env.MESSENGER_CONVERSATION_URL;

    if (
      this.browser &&
      this.browser.isConnected() &&
      this.page &&
      this.chatFrame &&
      this.composerSelector
    ) {
      try {
        if (
          targetUrl &&
          !conversationPathMatches(this.page.url(), targetUrl)
        ) {
          await this.page.goto(targetUrl, {
            waitUntil: "load",
            timeout: 90000,
          });
          await waitForTimeout(2000);
          this.chatFrame = null;
          this.composerSelector = null;
          this.chatFrame = await this.waitForChatFrame(120000);
          console.log("Messenger: nawigacja do wątku — OK");
        }
        return;
      } catch (e) {
        console.warn("Messenger: sesja wątpliwa, restart przeglądarki:", e);
        await this.closeBrowser();
      }
    }

    try {
      console.log(
        "Launch the browser for Messenger (profil:",
        messengerProfileDir(),
        ")..."
      );

      this.browser = await puppeteer.launch({
        headless: messengerHeadlessOption(),
        timeout: 60000,
        args: ["--no-sandbox"],
        userDataDir: messengerProfileDir(),
      });

      this.page = await this.browser.newPage();
      this.chatFrame = null;
      this.composerSelector = null;

      await this.page.setViewport({
        width: 1600,
        height: 900,
      });

      await this.page.goto(targetUrl, {
        waitUntil: "load",
        timeout: 90000,
      });
      await this._debugSnap("01-after-goto-conversation");

      await this._dismissCookieBanner();
      await this._debugSnap("02-after-cookie-banner");
      await waitForTimeout(1500);
      await this._dismissCookieBanner();

      const emailSel = await this._pickSelector(LOGIN_EMAIL_SELECTORS, 3000);

      if (emailSel) {
        console.log("Messenger: formularz logowania — loguję…");
        await this._debugSnap("03-login-form-detected");
        await this.page.type(emailSel, process.env.MESSENGER_EMAIL);
        const passSel = await this._pickSelector(LOGIN_PASS_SELECTORS, 5000);
        if (!passSel) {
          await this._debugSnap("error-no-password-field");
          throw new Error("Messenger: brak pola hasła na stronie logowania.");
        }
        await this.page.type(passSel, process.env.MESSENGER_PASSWORD);
        await waitForTimeout(500);
        const loginBtnCandidates = process.env.MESSENGER_FB_LOGIN_BUTTON_SELECTOR?.trim()
          ? [
              process.env.MESSENGER_FB_LOGIN_BUTTON_SELECTOR.trim(),
              ...LOGIN_BUTTON_SELECTORS,
            ]
          : LOGIN_BUTTON_SELECTORS;
        const btnSel = await this._pickSelector(loginBtnCandidates, 8000);
        if (!btnSel) {
          await this._debugSnap("error-no-login-button");
          throw new Error("Messenger: brak przycisku logowania.");
        }
        await this.page.click(btnSel);
        await this._debugSnap("04-after-login-click");

        /**
         * Comet często nie ma #email — warunek !#email dawał „sukces” na martwym login.php.
         * Czekamy wyłącznie na realny URL wątku wiadomości (bez login.php / checkpoint).
         */
        const loggedInUrl = await this.page
          .waitForFunction(
            () => {
              const h = window.location.href;
              if (/facebook\.com\/login/i.test(h)) return false;
              if (/checkpoint/i.test(h)) return false;
              return (
                /messenger\.com\/(t\/|e2ee\/t\/|group\/)/i.test(h) ||
                /facebook\.com\/messages\//i.test(h)
              );
            },
            { timeout: 180000 }
          )
          .then(() => this.page.url())
          .catch(() => null);

        if (!loggedInUrl) {
          await this._debugSnap("error-login-navigation-timeout");
          throw new Error(
            "Messenger: po logowaniu nie przeszło na /messages (timeout). Możliwe: złe hasło, 2FA, checkpoint lub captcha — zaloguj się ręcznie w profilu Chromium albo dokończ weryfikację."
          );
        }

        if (/facebook\.com\/login/i.test(loggedInUrl)) {
          await this._debugSnap("error-still-on-login-after-wait");
          throw new Error(
            "Messenger: nadal facebook.com/login — logowanie odrzucone lub wymagana dodatkowa weryfikacja."
          );
        }

        if (
          targetUrl &&
          !/\/messages\//i.test(loggedInUrl) &&
          /facebook\.com\//i.test(loggedInUrl)
        ) {
          await this.page.goto(targetUrl, {
            waitUntil: "load",
            timeout: 90000,
          });
        }

        await waitForTimeout(5000);
        await this._debugSnap("05-after-login-wait");
      } else {
        console.log("Messenger: sesja z profilu — pomijam wpisywanie hasła.");
        await waitForTimeout(3000);
        await this._debugSnap("03-skip-login-no-email-field");
      }

      this.chatFrame = await this.waitForChatFrame();
      await this._debugSnap("06-composer-ready");
      console.log(
        "Messenger: kompozytor — selektor:",
        this.composerSelector,
        "ramka:",
        this.chatFrame.url() || "(main)"
      );
    } catch (e) {
      await this._debugSnap("error-catch").catch(() => {});
      console.error(e);
      throw e;
    }
  }

  async sendMessages(messages) {
    const ctx = this.context();
    const composerSel = this.composerSelector;
    if (!composerSel) {
      throw new Error("Brak composerSelector — launchBrowser nie ustawił pola wiadomości.");
    }
    try {
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        await ctx.click(composerSel);
        await waitForTimeout(50);

        if (message.type === "text") {
          await ctx.focus(composerSel);
          await this.page.keyboard.type(message.value);
          await waitForTimeout(100);
        } else if (message.type === "map") {
          this.pageMap = await this.browser.newPage();
          await this.pageMap.setViewport({
            width: 400,
            height: 800,
          });
          const [latitude, longitude] = message.value;
          const mapUrl = `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/pin-l+ff0000(${longitude},${latitude})/${longitude},${latitude},13.5,0/400x800@2x?access_token=${process.env.MAPBOX_TOKEN}`;
          await this.pageMap.goto(mapUrl);
          await this.pageMap.keyboard.down("Control");
          await this.pageMap.keyboard.press("A");
          await this.pageMap.keyboard.up("Control");

          await this.pageMap.keyboard.down("Control");
          await this.pageMap.keyboard.press("C");
          await this.pageMap.keyboard.up("Control");

          await ctx.focus(composerSel);
          await this.page.keyboard.down("Control");
          await this.page.keyboard.press("V");
          await this.page.keyboard.up("Control");

          await waitForTimeout(1000);
        }

        const sendSel = await this.waitForSelectorInContext(
          ctx,
          SEND_BUTTON_CANDIDATES,
          { timeout: 25000 }
        ).catch(() => null);

        if (sendSel) {
          await ctx.click(sendSel);
        } else {
          await this.page.keyboard.press("Enter");
        }

        // Zawsze czekamy tylko chwilę (stabilizacja), bez wymuszonego oczekiwania na ikonę Like
        await waitForTimeout(POST_SEND_STABILIZE_FOLLOW_MS);
      }

      console.log("✅ Message sent!");
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  async closeBrowser() {
    try {
      if (this.browser) await this.browser.close();
    } catch (e) {
      console.log(e);
    }
    this.browser = null;
    this.page = null;
    this.chatFrame = null;
    this.composerSelector = null;
    this._debugRunId = null;
  }
}
