import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));

app.post("/slack/ask", (req, res) => {
  const question = req.body.text;

  console.log("Received question:", question);

  res.json({
    response_type: "ephemeral",
    text: `Got it 👍 You asked: "${question}"`,
  });
});

app.get("/", (req, res) => {
  res.send("Slack Ask Bot is running.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
