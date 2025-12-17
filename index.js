import fs from "fs";
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import crypto from "crypto";
import OpenAI from "openai";

const LOCATION = "brew"; // Brew & Brew

function bestMatchFromDoc(question, knowledgeText, filename = "") {
  const normalized = (knowledgeText || "").replace(/\r\n/g, "\n");

  // If there are no "## " headings, this becomes one big section (still fine)
  const sections = normalized
    .split(/\n## /)
    .map((s, i) => (i === 0 ? s : "## " + s));

  const qWords = question
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= 3);

  if (qWords.length === 0) return { score: 0, text: "" };

  // Strong filename fallback: if filename contains key words, guarantee a match
  const fileHay = filename.toLowerCase();
  const filenameHits = qWords.filter((w) => fileHay.includes(w)).length;

  let best = { score: filenameHits * 3, text: "" }; // weight filename hits

  for (const sec of sections) {
    const haystack = (filename + "\n" + sec).toLowerCase();
    let score = 0;

    for (const w of qWords) {
      if (haystack.includes(w)) score += 1;
    }

    // filename-weighted score
    score += filenameHits * 3;

    if (score > best.score) best = { score, text: sec };
  }

  // If filename hits exist but no section won, return the whole doc
  if (!best.text && filenameHits > 0) best.text = normalized;

  return best.score > 0 ? best : { score: 0, text: "" };
}

function loadLocationKnowledge(location) {
  const basePath = new URL(`./knowledge/${location}/`, import.meta.url);
  const docs = [];

  try {
    const files = fs.readdirSync(basePath);

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const text = fs.readFileSync(
        new URL(`./knowledge/${location}/${file}`, import.meta.url),
        "utf8"
      );

      docs.push({ file, text });
    }
  } catch (err) {
    console.warn(`Could not load knowledge for location: ${location}`, err);
  }

  return docs;
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

app.post("/slack/ask", (req, res) => {
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
  res.json({ response_type: "ephemeral", text: "Got it — thinking…" });

  // 2) Do the slow work AFTER responding (detached)
  (async () => {
    try {
      const knowledgeDocs = loadLocationKnowledge(LOCATION);
      console.log("Knowledge doc count:", knowledgeDocs.length);
      console.log("Loaded knowledge files:", knowledgeDocs.map((d) => d.file));

      const matches = [];

      for (const doc of knowledgeDocs) {
        const match = bestMatchFromDoc(question, doc.text, doc.file);
        console.log("Doc score:", doc.file, match.score);

        if (match.text) {
          matches.push({ file: doc.file, score: match.score, text: match.text });
        }
      }

      // Sort best-first and take top 2
      matches.sort((a, b) => b.score - a.score);

      // --- Hook #1 (debug): confirm whether the logging branch should run
      const BEST_SCORE_THRESHOLD = 4; // tune later
      const shouldLogUnanswered =
        matches.length === 0 || (matches[0] && matches[0].score < BEST_SCORE_THRESHOLD);

      console.log("shouldLogUnanswered:", shouldLogUnanswered);
      console.log("hasWebhookUrl:", !!process.env.UNANSWERED_WEBHOOK_URL);

      // --- Hook #2 (debug): log webhook response status/body
      if (shouldLogUnanswered && process.env.UNANSWERED_WEBHOOK_URL) {
        const resp = await fetch(process.env.UNANSWERED_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: process.env.UNANSWERED_WEBHOOK_SECRET,
            location: LOCATION,
            user_id: req.body.user_id,
            channel_id: req.body.channel_id,
            question,
            top_matches: matches.slice(0, 2).map((m) => `${m.file}(${m.score})`).join(", "),
          }),
        });

        const bodyText = await resp.text();
        console.log("Webhook status:", resp.status);
        console.log("Webhook body:", bodyText);
      }

      console.log("Top matches:", matches.slice(0, 2).map((m) => `${m.file}(${m.score})`));

      const context = matches
        .slice(0, 2)
        .map((m) => `Source: ${m.file}\n${m.text}`)
        .join("\n\n");

      const messages = [{ role: "system", content: SYSTEM_PROMPT }];

      if (context) {
        messages.push({
          role: "system",
          content:
            "Use the following internal knowledge as the primary source. " +
            "If it doesn't contain the answer, say you don't know and suggest asking a manager.\n\n" +
            context,
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
        const r = await fetch(responseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            response_type: "ephemeral",
            replace_original: true,
            text: answer,
          }),
        });

        if (!r.ok) {
          console.error("Slack response_url failed:", r.status, await r.text());
        }
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
  })();

  return;
});

app.get("/", (req, res) => res.send("Slack Ask Bot is running."));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
