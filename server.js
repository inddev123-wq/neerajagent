// Neeraj Agent — v2
// Feature 1: /write <rough text>  -> polishes text, shows it to you (unchanged from v1)
// Feature 2: /reply @person <rough text> -> drafts a message to that person,
//            shows you a preview with Send / Cancel buttons, and ONLY sends
//            after you click Send. It never sends silently.

const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // needed for actually sending messages
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
  GEMINI_API_KEY;

// Temporary storage for drafts waiting on your Send/Cancel click.
// Note: this resets if the free server restarts/sleeps — fine for personal use,
// worst case a draft expires and you just re-run the command.
const pendingDrafts = {};

app.get("/", (req, res) => {
  res.send("Neeraj Agent v2 is running.");
});

// ---------- FEATURE 1: /write ----------
app.post("/slack/write", async (req, res) => {
  const roughText = req.body.text;
  const responseUrl = req.body.response_url;

  if (!roughText || roughText.trim() === "") {
    return res.send("Usage: /write <your rough message>");
  }

  res.send("Polishing your message...");

  try {
    const polished = await polishWithGemini(roughText, "a Slack message");
    await sendToResponseUrl(responseUrl, polished);
  } catch (err) {
    console.error(err);
    await sendToResponseUrl(responseUrl, "Sorry, something went wrong.");
  }
});

// ---------- FEATURE 2: /reply @person <text> ----------
app.post("/slack/reply", async (req, res) => {
  const rawText = req.body.text || "";
  const responseUrl = req.body.response_url;

  // Slack sends mentions inside the text like: <@U12345|priya> need the report...
  const mentionMatch = rawText.match(/^<@(\w+)(\|[^>]+)?>\s*(.*)$/);

  if (!mentionMatch) {
    return res.send(
      "Usage: /reply @person your rough message  (make sure to actually @-mention them)"
    );
  }

  const targetUserId = mentionMatch[1];
  const roughText = mentionMatch[3];

  if (!roughText || roughText.trim() === "") {
    return res.send("Add a message after the @mention, e.g. /reply @priya need this by eod");
  }

  res.send("Drafting your reply...");

  try {
    const polished = await polishWithGemini(roughText, "a direct message to a coworker");

    const draftId = "draft_" + Date.now();
    pendingDrafts[draftId] = { targetUserId, message: polished };

    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "ephemeral",
        text: "Draft ready",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Draft to* <@${targetUserId}>:\n>${polished}`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Send" },
                style: "primary",
                action_id: "send_draft",
                value: draftId,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Cancel" },
                action_id: "cancel_draft",
                value: draftId,
              },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    console.error(err);
    await sendToResponseUrl(responseUrl, "Sorry, something went wrong drafting that.");
  }
});

// ---------- Handles the Send / Cancel button clicks ----------
app.post("/slack/interactions", async (req, res) => {
  const payload = JSON.parse(req.body.payload);
  const action = payload.actions[0];
  const draftId = action.value;
  const draft = pendingDrafts[draftId];

  if (!draft) {
    return res.send(); // draft expired or already handled
  }

  if (action.action_id === "send_draft") {
    delete pendingDrafts[draftId];

    // Actually send the message, using the bot token
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: draft.targetUserId, // sending straight to their user ID opens/uses the DM
        text: draft.message,
      }),
    });

    return res.send({
      replace_original: true,
      text: `Sent \u2705 to <@${draft.targetUserId}>`,
    });
  }

  if (action.action_id === "cancel_draft") {
    delete pendingDrafts[draftId];
    return res.send({
      replace_original: true,
      text: "Cancelled — nothing was sent.",
    });
  }

  res.send();
});

// ---------- Shared helpers ----------
async function polishWithGemini(roughText, context) {
  const prompt =
    `Rewrite the following rough note into ${context}. ` +
    "Keep it clear, professional but friendly, and concise. " +
    "Use Slack-style formatting (bold with *asterisks*) where helpful. " +
    "Only output the rewritten message, nothing else.\n\nRough note: " +
    roughText;

  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return text ? text.trim() : "Could not generate a rewrite. Try again.";
}

async function sendToResponseUrl(responseUrl, text) {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Neeraj Agent v2 listening on port ${PORT}`);
});
