// ============================================================
// SLACK EVENT HANDLER — Meeting Tasks Bot
// ============================================================
const { waitUntil } = require('@vercel/functions');

// Track bot thread timestamps for feedback detection
const botThreads = new Set();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Skip Slack retries
  if (req.headers['x-slack-retry-num']) {
    return res.status(200).json({ ok: true, skipped: 'retry' });
  }

  // Parse body (handle string, object, and stream)
  let event = req.body;
  if (typeof event === 'string') {
    try { event = JSON.parse(event); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  if (!event || typeof event !== 'object') {
    return res.status(400).json({ error: 'No body' });
  }

  // URL verification (Slack sends this during setup)
  if (event.type === 'url_verification') {
    return res.status(200).json({ challenge: event.challenge });
  }

  const slackEvent = event.event;
  if (!slackEvent) return res.status(200).json({ ok: true });

  // Skip bot messages (prevents infinite loops)
  if (slackEvent.bot_id || slackEvent.subtype === 'bot_message') {
    return res.status(200).json({ ok: true, skipped: 'bot' });
  }

  // Skip message_changed (URL unfurling fires these)
  if (slackEvent.subtype === 'message_changed') {
    return res.status(200).json({ ok: true, skipped: 'message_changed' });
  }

  // Skip other subtypes except file_share
  if (slackEvent.subtype && slackEvent.subtype !== 'file_share') {
    return res.status(200).json({ ok: true, skipped: slackEvent.subtype });
  }

  // ── ROUTE MESSAGES ──────────────────────────────────────
  if (slackEvent.type === 'message' || slackEvent.type === 'app_mention') {
    const text = slackEvent.text || '';
    const channel = slackEvent.channel;
    const ts = slackEvent.ts;
    const user = slackEvent.user;
    const threadTs = slackEvent.thread_ts;
    const cleanText = text.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, '$1');
    const lowerText = text.toLowerCase().trim();

    // ── 1. YOUR TRIGGER HERE ────────────────────────────
    // Example: Google Sheets URL detection
    // const sheetsMatch = cleanText.match(/https:\/\/docs\.google\.com\/spreadsheets(?:\/u\/\d+)?\/d\/([a-zA-Z0-9_-]+)/);
    // if (sheetsMatch) {
    //   res.status(200).json({ ok: true });
    //   waitUntil(handleTask({ channel, ts, user }, sheetsMatch[1]));
    //   return;
    // }

    // ── 2. BOT COMMANDS (mention bot name) ──────────────
    const botName = 'meeting-tasks-bot-v2';
    const mentionsBot = lowerText.includes(botName) || text.includes('<@' + (process.env.SLACK_BOT_USER_ID || '') + '>');

    if (mentionsBot) {
      if (lowerText.includes('list rules') || lowerText.includes('show rules')) {
        res.status(200).json({ ok: true });
        waitUntil(handleListRules({ channel, ts }));
        return;
      }
      const removeMatch = lowerText.match(/remove rule\s+(\d+)/);
      if (removeMatch) {
        res.status(200).json({ ok: true });
        waitUntil(handleRemoveRule({ channel, ts, user }, parseInt(removeMatch[1])));
        return;
      }
      if (lowerText.includes('help')) {
        res.status(200).json({ ok: true });
        waitUntil(handleHelp({ channel, ts }));
        return;
      }
      // Default: treat as training feedback
      res.status(200).json({ ok: true });
      waitUntil(handleTrainingMessage({ channel, text, ts, user }));
      return;
    }

    // ── 3. THREAD REPLIES → Feedback Loop ───────────────
    if (threadTs && threadTs !== ts) {
      res.status(200).json({ ok: true });
      waitUntil(handleThreadReply({ channel, text, ts, threadTs, user }));
      return;
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
};

// ============================================================
// HANDLE TASK — Your main bot logic
// ============================================================
async function handleTask(ctx, data) {
  const { postSlackMessage } = require('../lib/slack');
  const { channel, ts: threadTs, user } = ctx;

  await postSlackMessage(channel, threadTs, '\u{1F50D} Processing...');

  try {
    // TODO: Call your engine here
    // const result = await processTask(data);
    // await postSlackMessage(channel, threadTs, 'Done! ' + JSON.stringify(result));

    // Track this thread for feedback
    botThreads.add(threadTs);
  } catch (err) {
    console.error('[meeting-tasks-bot-v2] Error:', err);
    await postSlackMessage(channel, threadTs, '\u{274C} Error: ' + err.message);
  }
}

// ============================================================
// THREAD REPLY → Feedback
// ============================================================
async function handleThreadReply(ctx) {
  const { channel, text, ts, threadTs, user } = ctx;

  // Check if thread parent is ours (simple: check in-memory set)
  if (!botThreads.has(threadTs)) {
    // Fallback: check via API if parent is a bot message
    try {
      const token = process.env.SLACK_BOT_TOKEN;
      const resp = await fetch('https://slack.com/api/conversations.replies?channel=' + channel + '&ts=' + threadTs + '&limit=1', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const data = await resp.json();
      if (data.ok && data.messages && data.messages[0] && data.messages[0].bot_id) {
        botThreads.add(threadTs);
      } else {
        return; // Not our thread
      }
    } catch (e) { return; }
  }

  await handleTrainingMessage({ channel, text, ts: threadTs, user, isFeedback: true });
}

// ============================================================
// TRAINING MESSAGE
// ============================================================
async function handleTrainingMessage(ctx) {
  const { postSlackMessage } = require('../lib/slack');
  const { addTrainingRule, getTrainingRules } = require('../lib/rules');
  const Anthropic = require('@anthropic-ai/sdk');

  const { channel, text, ts, user, isFeedback } = ctx;
  const client = new Anthropic();
  const currentRules = await getTrainingRules();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 500,
    messages: [{ role: 'user', content: `You are Meeting Tasks Bot. A team member gave feedback. Parse it into a rule.
${isFeedback ? 'This is a thread reply on a bot result post — extract learnable rules.' : ''}

Message: "${text}"

Existing rules (avoid duplicates):
${currentRules.map((r, i) => (i+1) + '. ' + r.rule).join('\n')}

Respond with JSON only:
{
  "isTrainingRule": true/false,
  "rule": "Clear rule to add",
  "category": "process|formatting|quality|other",
  "acknowledgment": "Short confirmation",
  "isDuplicate": true/false
}` }]
  });

  try {
    const parsed = JSON.parse(response.content[0].text);
    if (parsed.isTrainingRule && !parsed.isDuplicate) {
      await addTrainingRule({
        rule: parsed.rule, category: parsed.category,
        addedBy: user, addedAt: new Date().toISOString(),
        sourceMessage: text, source: isFeedback ? 'thread_feedback' : 'direct'
      });
      const count = (await getTrainingRules()).length;
      await postSlackMessage(channel, ts, '\u{2705} ' + parsed.acknowledgment + '\n_Rule added (' + count + ' total)._');
    } else if (parsed.isDuplicate) {
      await postSlackMessage(channel, ts, '\u{1F44D} ' + parsed.acknowledgment + '\n_Already have a similar rule._');
    } else {
      await postSlackMessage(channel, ts, parsed.acknowledgment);
    }
  } catch (err) {
    await postSlackMessage(channel, ts, 'Got it — I\'ll factor that in. \u{1F44D}');
  }
}

// ============================================================
// COMMANDS
// ============================================================
async function handleListRules(ctx) {
  const { postSlackMessage } = require('../lib/slack');
  const { listRulesFormatted } = require('../lib/rules');
  await postSlackMessage(ctx.channel, ctx.ts, await listRulesFormatted());
}

async function handleRemoveRule(ctx, index) {
  const { postSlackMessage } = require('../lib/slack');
  const { removeTrainingRule, getTrainingRules } = require('../lib/rules');
  const rules = await getTrainingRules();
  if (index < 1 || index > rules.length) {
    await postSlackMessage(ctx.channel, ctx.ts, '\u{274C} Rule #' + index + ' not found. I have ' + rules.length + ' rules.');
    return;
  }
  const removed = rules[index - 1];
  await removeTrainingRule(index - 1);
  await postSlackMessage(ctx.channel, ctx.ts, '\u{1F5D1} Removed: "' + removed.rule + '"');
}

async function handleHelp(ctx) {
  const { postSlackMessage } = require('../lib/slack');
  await postSlackMessage(ctx.channel, ctx.ts,
    '\u{1F916} *Meeting Tasks Bot — Commands*\n\n' +
    '• *Post a trigger* — I\'ll process it\n' +
    '• *Reply in my threads* — Give feedback, I\'ll learn\n' +
    '• *"meeting-tasks-bot-v2 list rules"* — See my rules\n' +
    '• *"meeting-tasks-bot-v2 remove rule N"* — Delete a rule\n' +
    '• *"meeting-tasks-bot-v2 help"* — This message'
  );
}
