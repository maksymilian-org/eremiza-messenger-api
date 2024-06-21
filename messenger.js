import path from "path";
import puppeteer from "puppeteer";
import { waitForTimeout } from "./utils.js";
import { mail } from "./mail.js";

export class Messenger {
  browser = null;
  page = null;
  pageMap = null;

  constructor() {}

  async launchBrowser() {
    if (this.browser && this.page) {
      return;
    }

    try {
      console.time("Messenger sending");
      console.log("Launch the browser for Messenger...");

      // Launch the browser
      this.browser = await puppeteer.launch({
        headless: "shell",
        timeout: 60000,
        args: ["--no-sandbox"],
      });

      // Create a page
      this.page = await this.browser.newPage();

      await this.page.setViewport({
        width: 1600,
        height: 900,
      });

      // Go to your site
      await this.page.goto(process.env.MESSENGER_CONVERSATION_URL);

      await this.page.waitForSelector('[data-cookiebanner="accept_button"]');
      await this.page.click('[data-cookiebanner="accept_button"]');

      await this.page.type("#email", process.env.MESSENGER_EMAIL);
      await this.page.type("#pass", process.env.MESSENGER_PASSWORD);

      await waitForTimeout(500);
      await this.page.click("#loginbutton");

      await this.page.screenshot({ path: "./screenshot.png" });
      const __dirname = path.resolve(path.dirname(""));
      await mail(process.env.EMAIL_TITLE, "debug", [
        {
          filename: "screenshot.png",
          path: __dirname + "/screenshot.png",
          cid: "screenshot",
        },
      ]);

      await this.page.waitForSelector('[aria-label="Thread composer"] p');
    } catch (e) {
      console.log(e);
    }
  }

  async sendMessages(messages) {
    try {
      // Message
      for (const message of messages) {
        await this.page.click('[aria-label="Thread composer"] p');
        await waitForTimeout(50);

        if (message.type === "text") {
          await this.page.keyboard.type(message.value);
          await waitForTimeout(100);
        } else if (message.type === "map") {
          // Create a page
          this.pageMap = await browser.newPage();
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

          await this.page.keyboard.down("Control");
          await this.page.keyboard.press("V");
          await this.page.keyboard.up("Control");

          await waitForTimeout(1000);
        }

        await this.page.waitForSelector('[aria-label="Press enter to send"]');
        await this.page.click('[aria-label="Press enter to send"]');

        await this.page.waitForSelector('[aria-label="Send a Like"]');
        console.timeEnd("Message");
      }

      console.timeEnd("Messenger sending");
      console.log("✅ Message sent!");
    } catch (e) {
      console.log(e);
    }
  }

  async closeBrowser() {
    try {
      await this.browser.close();
    } catch (e) {
      console.log(e);
    }
  }
}
