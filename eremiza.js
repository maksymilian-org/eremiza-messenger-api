import puppeteer from "puppeteer";

export const getLastAlert = async () => {
  const LOGIN_PAGE_URL = "https://e-remiza.pl/OSP.UI.SSO/logowanie";
  const ALERTS_PAGE_URL = "https://e-remiza.pl/OSP.UI.EREMIZA/alarmy";

  const LOGIN = process.env.EREMIZA_LOGIN;
  const PASSWORD = process.env.EREMIZA_PASSWORD;

  try {
    console.time();
    console.log("Launch browser for eremiza...");
    // Launch the browser
    const browser = await puppeteer.launch({
      headless: "shell",
      timeout: 60000,
      args: ["--no-sandbox"],
    });

    // Create a page
    const page = await browser.newPage();

    // Login
    await page.goto(LOGIN_PAGE_URL);

    await page.type(
      "#ContentPlaceHolder1_ASPxCallbackPanelLogin_ASPxTextBoxUserName_I",
      LOGIN
    );
    await page.type(
      "#ContentPlaceHolder1_ASPxCallbackPanelLogin_ASPxTextBoxPassword_I",
      PASSWORD
    );
    await page.click("#ContentPlaceHolder1_ASPxButtonLogin");
    await page.waitForNavigation();

    // Go to the alerts page
    await page.goto(ALERTS_PAGE_URL);

    // Get the last alert data from the table element
    await page.waitForSelector("#MainContent_ASPxGridViewAlarms_DXMainTable");
    const alert = await page.$$eval(
      "#MainContent_ASPxGridViewAlarms_DXDataRow0 td",
      (anchors) => {
        return anchors.map((anchor) => {
          // Get a full description from title tag of the span inside td element
          if (anchor.id === "MainContent_ASPxGridViewAlarms_tccell0_3") {
            return anchor?.getElementsByTagName("span")[0].title?.trim();
          } else {
            return anchor?.textContent?.trim();
          }
        });
      }
    );
    // Close browser
    browser.close();

    const [date, type, address, description, _, author, coords] = alert;

    console.timeEnd();

    return {
      date,
      type,
      address,
      description,
      author,
      coords,
    };
  } catch (error) {
    console.log(error);
  }
};
