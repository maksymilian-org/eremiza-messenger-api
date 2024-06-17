import express from "express";
import { sendMessages } from "./messenger.js";
import { validate } from "./validate.js";

validate();

const app = express();
const port = process.env.PORT || 3000;

app.use("/send", async (req, res, next) => {
  console.log("Request: ", req.url);
  await sendMessages();
  next();
});

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/send", (req, res) => {
  res.status(200).send("OK");
});

app.listen(port, () =>
  console.log(`Website-checker is listening on port ${port}.`)
);
