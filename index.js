import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Capture raw body for Slack signature verification
app.use(
  bodyParser.urlencoded({
    extended: true,
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

function verifySlackRequest(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;

  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSignature = req.headers["x-slack-signature"];

  if (!timestamp || !slackSignature || !req.rawBody) return false;

  // Prevent replay attacks: reject if older than 5 minutes
  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > fiveMinutes) return false;

  const baseString = `v0:${timestamp}:${req.rawBody}`;
  const mySignature =
    "v0=" +
    crypto.createHmac("sha256", signingSecret).update(baseString, "utf8").digest("hex");

  // Timing-safe compare
  const a = Buffer.from(mySignature, "utf8");
  const b = Buffer.from(slackSignature, "utf8");
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

app.post("/slack/ask", (req, res) => {
  if (!verifySlackRequest(req)) {
    return res.status(401).send("Invalid signature");
  }

  const question = req.body.text || "";
  console.log("Verified Slack request. Question:", question);

  // Still hard-coded response for now
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
