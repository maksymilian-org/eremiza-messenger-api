import express from "express";
import dotenv from "dotenv";
import { validate } from "./validate.js";
import { getLastAlert } from "./eremiza.js";
import { sendMessages } from "./messenger.js";
import { getData, setAlertData } from "./gist.js";

dotenv.config();
validate();

const app = express();
const port = process.env.PORT || 3000;

const launch = async () => {
  const lastEremizaAlert = await getLastAlert();
  const lastGistAlert = await getData();

  if (lastEremizaAlert.date === lastGistAlert.date) {
    console.log("Alert received previously. Give up sending messages");
  }

  setAlertData(lastEremizaAlert);
  const message = `🚨 ${lastEremizaAlert.type}, ${lastEremizaAlert.address}, ${lastEremizaAlert.description}`;
  await sendMessages([message]);
};

app.get("/", (req, res) => {
  launch();
  res.status(200).send("OK");
});

app.listen(port, () =>
  console.log(`Website-checker is listening on port ${port}.`)
);
