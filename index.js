import express from "express";
import dotenv from "dotenv";
import { validate } from "./validate.js";
import { getLastAlert } from "./eremiza.js";
import { sendMessages } from "./messenger.js";
import { getData, getIsChecking, setAlertData, setIsChecking } from "./gist.js";
import { waitForTimeout } from "./utils.js";

dotenv.config();
validate();

const app = express();
const port = process.env.PORT || 3000;

const launch = async () => {
  try {
    const ITERATION_OF_CHECKING = 4;
    const WAIT_BETWEEN_CHECKING = 15000;

    const isChecking = await getIsChecking();
    if (!isChecking) {
      await setIsChecking(true);

      for (let i = 0; i < ITERATION_OF_CHECKING; i++) {
        console.log("Iteration", i + 1, "of checking");
        const [lastEremizaAlert, lastGistAlert] = await Promise.all([
          getLastAlert(),
          getData(),
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

        console.log("Setting new alert...");
        setAlertData(lastEremizaAlert);
        const message = `🚨 ${lastEremizaAlert.type}, ${lastEremizaAlert.address}, ${lastEremizaAlert.description}`;
        console.log("Sending message about new alert...");
        await sendMessages([message]);
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
