import puppeteer from "puppeteer";
import { waitForTimeout } from "./utils.js";

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

      await waitForTimeout(100);
      await this.page.click("#loginbutton");

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
            width: 800,
            height: 400,
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

// export async function sendMessages(messages) {
//   try {
//     console.time("Messenger sending");
//     console.log("Launch the browser for Messenger...");

//     // Launch the browser
//     const browser = await puppeteer.launch({
//       headless: "shell",
//       timeout: 60000,
//       args: ["--no-sandbox"],
//     });

//     // Create a page
//     const page = await browser.newPage();

//     await page.setViewport({
//       width: 1600,
//       height: 900,
//     });

//     // Go to your site
//     await page.goto(process.env.MESSENGER_CONVERSATION_URL);

//     await page.waitForSelector('[data-cookiebanner="accept_button"]');
//     await page.click('[data-cookiebanner="accept_button"]');

//     await page.type("#email", process.env.MESSENGER_EMAIL);
//     await page.type("#pass", process.env.MESSENGER_PASSWORD);

//     await waitForTimeout(100);
//     await page.click("#loginbutton");

//     // await page.waitForSelector(
//     //   "#mw-numeric-code-input-prevent-composer-focus-steal"
//     // );

//     // await page.type(
//     //   "#mw-numeric-code-input-prevent-composer-focus-steal",
//     //   "123456"
//     // );

//     // await page.waitForSelector('[aria-label="Not now"]');
//     // await page.click('[aria-label="Not now"]');

//     await page.waitForSelector('[aria-label="Thread composer"] p');

//     // Message
//     for (const message of messages) {
//       await page.click('[aria-label="Thread composer"] p');
//       await waitForTimeout(50);

//       if (message.type === "text") {
//         await page.keyboard.type(message.value);
//         await waitForTimeout(100);
//       } else if (message.type === "map") {
//         // Create a page
//         const pageMap = await browser.newPage();
//         await pageMap.setViewport({
//           width: 800,
//           height: 400,
//         });
//         const [latitude, longitude] = message.value;
//         const mapUrl = `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/pin-l+ff0000(${longitude},${latitude})/${longitude},${latitude},13.5,0/400x800@2x?access_token=${process.env.MAPBOX_TOKEN}`;
//         await pageMap.goto(mapUrl);
//         await pageMap.keyboard.down("Control");
//         await pageMap.keyboard.press("A");
//         await pageMap.keyboard.up("Control");

//         await pageMap.keyboard.down("Control");
//         await pageMap.keyboard.press("C");
//         await pageMap.keyboard.up("Control");

//         await page.keyboard.down("Control");
//         await page.keyboard.press("V");
//         await page.keyboard.up("Control");

//         await waitForTimeout(1000);
//       }

//       await page.waitForSelector('[aria-label="Press enter to send"]');
//       await page.click('[aria-label="Press enter to send"]');

//       await page.waitForSelector('[aria-label="Send a Like"]');
//       console.timeEnd("Message");
//     }

//     console.timeEnd("Messenger sending");
//     console.log("✅ Message sent!");
//     // Close browser.
//     await browser.close();
//   } catch (error) {
//     console.log(error);
//   }
// }
