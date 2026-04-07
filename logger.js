/**
 * Prefiks czasu w logach (sv-SE + ms), bez nazwy strefy w tekście.
 * Strefa: `LOG_TIMEZONE` (IANA) albo — gdy puste — domyślna strefa procesu.
 * `dotenv` tutaj, żeby `.env` działał mimo importu loggera przed `dotenv.config()` w `index.js`.
 */
import dotenv from "dotenv";

dotenv.config();

const ts = () => {
  const d = new Date();
  const fromEnv = process.env.LOG_TIMEZONE?.trim();
  const opts = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  };
  if (fromEnv) {
    opts.timeZone = fromEnv;
  }
  return new Intl.DateTimeFormat("sv-SE", opts).format(d);
};
const orig = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  ...(console.debug && { debug: console.debug.bind(console) }),
};

console.log = (...args) => orig.log(`[${ts()}]`, ...args);
console.info = (...args) => orig.info(`[${ts()}]`, ...args);
console.warn = (...args) => orig.warn(`[${ts()}]`, ...args);
console.error = (...args) => orig.error(`[${ts()}]`, ...args);
if (orig.debug) {
  console.debug = (...args) => orig.debug(`[${ts()}]`, ...args);
}
