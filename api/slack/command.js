// ============================================================
// SLASH COMMAND HANDLER — /transcribe
// ============================================================
const { openModal, buildTranscriptModal } = require('../lib/slack');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Slack sends slash command data as application/x-www-form-urlencoded
  // Vercel parses it into req.body as an object
  const { trigger_id } = req.body || {};

  if (!trigger_id) {
    console.error('No trigger_id in slash command payload');
    return res.status(200).json({ response_type: 'ephemeral', text: 'Error: Missing trigger_id. Please try again.' });
  }

  // Open the transcript paste modal
  try {
    await openModal(trigger_id, buildTranscriptModal());
    // Return empty 200 — Slack expects this for slash commands
    return res.status(200).send('');
  } catch (err) {
    console.error('Failed to open modal:', err);
    return res.status(200).json({ response_type: 'ephemeral', text: 'Error opening modal. Please try again.' });
  }
};
