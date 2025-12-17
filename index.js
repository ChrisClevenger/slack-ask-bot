import fs from "fs";
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import crypto from "crypto";
import OpenAI from "openai";

function findRelevantKnowledge(question, knowledgeText) {
  const sections = knowledgeText
    .split(/\n## /)
    .map((s, i) => (i === 0 ? s : "## " + s));

  const q = question.toLowerCase();
  let best = { score: 0, text: "" };

  for (const sec of sections) {
    const lowered = sec.toLowerCase();
    let score = 0;

    for (const word of q.split(/\s+/)) {
      const w = word.replace(/[^a-z0-9]/g, "");
      if (w.length >= 4 && lowered.includes(w)) score += 1;
    }

    if (score > best.score) best = { score, text: sec };
  }

  return best.score > 0 ? best.text : "";
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > fiveMinutes) return false;

  const baseString = `v0:${timestamp}:${req.rawBody}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(baseString, "utf8")
      .digest("hex");

  const a = Buffer.from(mySignature, "utf8");
  const b = Buffer.from(slackSignature, "utf8");
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

const SYSTEM_PROMPT = `
You are an internal operations assistant for a group of coffee shops and bars.
Give clear, practical, plain-language answers for staff who are mid-shift.

Rules:
- Keep it short (aim for 5-10 lines).
- Use bullets or steps when helpful.
- If you’re not sure, say so and recommend asking a manager.
- Never invent store policy.
- For anything involving safety, alcohol service, cash handling, or HR: be extra careful and conservative.
`.trim();

app.post("/slack/ask", async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).send("Invalid signature");

  const question = (req.body.text || "").trim();
  const responseUrl = req.body.response_url;

  if (!question) {
    return res.json({
      response_type: "ephemeral",
      text: "Try: `/ask How do I close the bar?`",
    });
  }

  // 1) ACK immediately so Slack doesn't time out
  res.json({
    response_type: "ephemeral",
    text: "Got it — thinking…",
  });

  // 2) Do the slow work AFTER responding
  try {
    let knowledgeText = "";
    try {
      knowledgeText = fs.readFileSync(
        new URL("./knowledge.md", import.meta.url),
        "utf8"
      );
    } catch {
      // ok if missing
    }

    const relevant = knowledgeText
      ? findRelevantKnowledge(question, knowledgeText)
      : "";

    const messages = [{ role: "system", content: SYSTEM_PROMPT }];

    if (relevant) {
      messages.push({
        role: "system",
        content:
          "Use the following internal knowledge as the primary source. " +
          "If it doesn't contain the answer, say you don't know and suggest asking a manager.\n\n" +
          relevant,
      });
    }

    messages.push({ role: "user", content: question });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2,
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I couldn’t generate an answer.";

    // 3) Send final answer back via response_url
    if (responseUrl) {
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response_type: "ephemeral",
          replace_original: true,
          text: answer,
        }),
      });
    }
  } catch (err) {
    console.error("Async handler error:", err?.message || err);

    if (responseUrl) {
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response_type: "ephemeral",
          replace_original: true,
          text: "I hit an error talking to the AI. Try again in a minute.",
        }),
      });
    }
  }
});


app.get("/", (req, res) => res.send("Slack Ask Bot is running."));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));



