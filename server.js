// Neeraj Agent — v2
// Feature 1: /write <rough text>  -> polishes text, shows it to you (unchanged from v1)
// Feature 2: /reply @person <rough text> -> drafts a message to that person,
//            shows you a preview with Send / Cancel buttons, and ONLY sends
//            after you click Send. It never sends silently.

const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // needed for actually sending messages
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

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
    const polished = await polishWithClaude(roughText, "a Slack message");
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
    const polished = await polishWithClaude(roughText, "a direct message to a coworker");

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
async function polishWithClaude(roughText, context) {
  const prompt =
    `Rewrite the following rough note into ${context}. ` +
    "Keep it clear, professional but friendly, and concise. " +
    "Use Slack-style formatting (bold with *asterisks*) where helpful. " +
    "Only output the rewritten message, nothing else.\n\nRough note: " +
    roughText;

  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data?.content?.[0]?.text;
  if (!text) {
    // Log the FULL Claude response so we can see the real reason it failed
    console.error("Claude did not return text. Full response:", JSON.stringify(data));
  }
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
