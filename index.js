import express from "express";
import dotenv from "dotenv";
import { validate } from "./validate.js";
import { getLastAlert } from "./eremiza.js";
import { Messenger } from "./messenger.js";
import { getData, getIsChecking, setAlertData, setIsChecking } from "./gist.js";
import { waitForTimeout } from "./utils.js";

dotenv.config();
validate();

const app = express();
const port = process.env.PORT || 3000;

const launch = async () => {
  console.time("Message");
  try {
    const ITERATION_OF_CHECKING = 6;
    const WAIT_BETWEEN_CHECKING = 15000;
    const messenger = new Messenger();

    const isChecking = await getIsChecking();
    if (!isChecking) {
      for (let i = 0; i < ITERATION_OF_CHECKING; i++) {
        console.log("Iteration", i + 1, "of checking");
        const [lastEremizaAlert, lastGistAlert] = await Promise.all([
          getLastAlert(),
          getData(),
          setIsChecking(true),
          messenger.launchBrowser(),
        ]);

        if (lastEremizaAlert.date === lastGistAlert.date) {
          console.log(
            "Nothing new on e-Remiza alerts list. Waiting for the next iteration of checking..."
          );
          if (i + 1 !== ITERATION_OF_CHECKING) {
            await waitForTimeout(WAIT_BETWEEN_CHECKING);
          }
          continue;
        }

        const directionsLink = `https://www.google.com/maps/dir/?api=1&origin=${process.env.FIRE_BRIGADE_COORDINATES}&destination=${lastEremizaAlert.coords}&travelmode=driving&layer=traffic`;
        const message = `🚨 ${lastEremizaAlert.type}, ${lastEremizaAlert.address}, ${lastEremizaAlert.description} ${directionsLink}`;

        console.log("Sending messages about new alert...");
        // await sendMessages([
        //   { type: "text", value: message },
        //   // { type: "map", value: lastEremizaAlert.coords },
        // ]);
        await messenger.sendMessages([
          { type: "text", value: message },
          // { type: "map", value: lastEremizaAlert.coords },
        ]),
          console.log("Saving new alert...");
        await setAlertData(lastEremizaAlert);

        await messenger.closeBrowser();

        break;
      }
      await setIsChecking(false);
      console.log("Checking finnished");
    } else {
      console.log("Already checking. Give up sending messages");
    }
  } catch (err) {
    await setIsChecking(false);
    console.log(err);
  }
};

app.get("/", (req, res) => {
  launch();
  res.status(200).send("OK");
});

app.get("/heartbeat", (req, res) => {
  console.log("Heartbeat received");
  res.status(200).send("OK");
});

app.listen(port, () =>
  console.log(`Website-checker is listening on port ${port}.`)
);
