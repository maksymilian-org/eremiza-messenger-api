import puppeteer from "puppeteer";

const waitForTimeout = (milliseconds) =>
  new Promise((r) => setTimeout(r, milliseconds));

export async function sendMessages(messages) {
  try {
    console.time();
    console.log("Launch the browser for Messenger...");

    // Launch the browser
    const browser = await puppeteer.launch({
      headless: "shell",
      timeout: 60000,
      args: ["--no-sandbox"],
    });

    // Create a page
    const page = await browser.newPage();

    await page.setViewport({
      width: 1600,
      height: 900,
    });

    // Go to your site
    await page.goto(process.env.MESSENGER_CONVERSATION_URL);

    await page.waitForSelector('[data-cookiebanner="accept_button"]');
    await page.click('[data-cookiebanner="accept_button"]');

    await page.type("#email", process.env.MESSENGER_EMAIL);
    await page.type("#pass", process.env.MESSENGER_PASSWORD);

    await waitForTimeout(100);
    await page.click("#loginbutton");

    // await page.waitForSelector(
    //   "#mw-numeric-code-input-prevent-composer-focus-steal"
    // );

    // await page.type(
    //   "#mw-numeric-code-input-prevent-composer-focus-steal",
    //   "123456"
    // );

    // await page.waitForSelector('[aria-label="Not now"]');
    // await page.click('[aria-label="Not now"]');

    // Message
    for (const message of messages) {
      console.log("Message:", message);
      await page.waitForSelector('[aria-label="Thread composer"] p');
      await page.click('[aria-label="Thread composer"] p');
      await waitForTimeout(50);

      await page.keyboard.type(message);
      await waitForTimeout(100);

      await page.waitForSelector('[aria-label="Press enter to send"]');
      await page.click('[aria-label="Press enter to send"]');

      await page.waitForSelector('[aria-label="Send a Like"]');
    }

    console.timeEnd();
    console.log("✅ Done!");
    // Close browser.
    await browser.close();
  } catch (error) {
    console.log(error);
  }
}
