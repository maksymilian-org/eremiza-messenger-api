import fs from "fs/promises";
import path from "path";

export function messengerDebugEnabled() {
  const v = process.env.MESSENGER_DEBUG?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function messengerDebugDir() {
  return (
    process.env.MESSENGER_DEBUG_DIR?.trim() ||
    path.join(process.cwd(), ".data", "messenger-debug")
  );
}

function safeSlug(step) {
  return String(step)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

/**
 * Zrzut ekranu + HTML głównej strony + próba HTML każdej ramki (cross-origin → plik .txt z komunikatem).
 */
export async function saveMessengerDebugSnapshot(page, runId, step) {
  if (!messengerDebugEnabled() || !page) return null;

  const slug = safeSlug(step);
  const sessionDir = path.join(messengerDebugDir(), runId);
  await fs.mkdir(sessionDir, { recursive: true });

  const pngPath = path.join(sessionDir, `${slug}.png`);
  const htmlPath = path.join(sessionDir, `${slug}.html`);
  const metaPath = path.join(sessionDir, `${slug}.meta.txt`);

  await page.screenshot({ path: pngPath, fullPage: true });

  let mainHtml = "";
  try {
    mainHtml = await page.content();
  } catch (e) {
    mainHtml = `<!-- page.content() failed: ${e?.message} -->\n`;
  }
  await fs.writeFile(htmlPath, mainHtml, "utf8");

  const frames = page.frames();
  const lines = [
    `step: ${step}`,
    `url: ${page.url()}`,
    `frames: ${frames.length}`,
    "",
  ];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    let frameUrl = "";
    try {
      frameUrl = frame.url();
    } catch {
      frameUrl = "(url error)";
    }
    lines.push(`--- frame[${i}] ${frameUrl}`);

    const framePath = path.join(sessionDir, `${slug}_frame-${i}.html`);
    const frameErrPath = path.join(sessionDir, `${slug}_frame-${i}_no-access.txt`);
    try {
      const html = await frame.evaluate(
        () => document.documentElement?.outerHTML ?? ""
      );
      await fs.writeFile(framePath, html, "utf8");
    } catch (e) {
      await fs.writeFile(
        frameErrPath,
        `Brak dostępu do DOM ramki (np. cross-origin): ${e?.message}\n`,
        "utf8"
      );
    }
  }

  await fs.writeFile(metaPath, lines.join("\n"), "utf8");

  console.log(
    `Messenger debug [${step}]: ${pngPath} + ${htmlPath} (${frames.length} ramek)`
  );
  return sessionDir;
}
