// ============================================================
// CRON — Nudge for unapproved task lists (runs hourly)
// ============================================================
const { postMessage } = require('../lib/slack');

module.exports = async function handler(req, res) {
  // Verify cron secret
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Note: In serverless, the pendingTasks Map from interact.js won't persist
  // across function invocations. For v1, the nudge is a lightweight reminder.
  // In v2, we'd use KV storage for pending tasks.

  console.log('Nudge cron ran at', new Date().toISOString());
  return res.status(200).json({ ok: true, message: 'Nudge check completed' });
};
