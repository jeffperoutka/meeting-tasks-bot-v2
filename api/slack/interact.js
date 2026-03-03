// ============================================================
// INTERACTION HANDLER — Modal submissions + button clicks
// ============================================================
const { waitUntil } = require('@vercel/functions');
const { postMessage, updateMessage, buildTaskListBlocks, buildConfirmationBlocks } = require('../lib/slack');
const { extractTasksFromTranscript } = require('../lib/engine');
const { createAllTasks, checkForDuplicates } = require('../lib/clickup');

// In-memory store for pending task lists (keyed by message ts)
const pendingTasks = new Map();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Slack sends interaction payloads as application/x-www-form-urlencoded with a "payload" field
  let payload;
  try {
    const raw = req.body?.payload || req.body;
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.error('Failed to parse interaction payload:', err);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const { type } = payload;

  // Modal submission — user submitted the transcript
  if (type === 'view_submission') {
    // Respond immediately (Slack requires this within 3s)
    res.status(200).json({ response_action: 'clear' });

    waitUntil(handleTranscriptSubmission(payload));
    return;
  }

  // Button click — approve or reject
  if (type === 'block_actions') {
    const action = payload.actions?.[0];
    if (!action) return res.status(200).json({ ok: true });

    // Respond immediately
    res.status(200).json({ ok: true });

    if (action.action_id === 'approve_tasks') {
      waitUntil(handleApprove(payload));
    } else if (action.action_id === 'reject_tasks') {
      waitUntil(handleReject(payload));
    }
    return;
  }

  return res.status(200).json({ ok: true });
};

// ── TRANSCRIPT SUBMISSION ──────────────────────────────
async function handleTranscriptSubmission(payload) {
  const userId = payload.user?.id;
  const channel = process.env.SLACK_CHANNEL_ID || 'C0AJ2HVFQJF';
  const transcript = payload.view?.state?.values?.transcript_block?.transcript_input?.value || '';

  if (!transcript.trim()) {
    await postMessage(channel, ':x: Empty transcript submitted. Please try again.');
    return;
  }

  // Post a processing message
  const processingMsg = await postMessage(channel, ':hourglass_flowing_sand: Extracting tasks from transcript...');
  const processingTs = processingMsg.ts;

  try {
    // Extract tasks with Claude
    const result = await extractTasksFromTranscript(transcript);
    const { summary, tasks } = result;

    if (!tasks || tasks.length === 0) {
      await updateMessage(channel, processingTs, ':shrug: No actionable tasks found in the transcript.', [
        { type: 'section', text: { type: 'mrkdwn', text: `:shrug: *No actionable tasks found.*\n\n*Summary:* ${summary || 'N/A'}` } },
      ]);
      return;
    }

    // Check for duplicates against existing ClickUp tasks
    const tasksWithDupes = await checkForDuplicates(tasks);

    // Build the task list with approve/reject buttons
    const blocks = buildTaskListBlocks(summary, tasksWithDupes, userId);

    // Update the processing message with the task list
    await updateMessage(channel, processingTs, `Meeting Tasks Extracted — ${tasks.length} task(s)`, blocks);

    // Store tasks for when user clicks Approve
    pendingTasks.set(processingTs, {
      tasks: tasksWithDupes,
      summary,
      submittedBy: userId,
      submittedAt: Date.now(),
    });

    console.log(`Stored ${tasks.length} pending tasks under ts=${processingTs}`);

  } catch (err) {
    console.error('Transcript processing error:', err);
    await updateMessage(channel, processingTs, `:x: Error extracting tasks: ${err.message}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `:x: *Error extracting tasks:* ${err.message}\n\nPlease try again with /transcribe.` } },
    ]);
  }
}

// ── APPROVE TASKS ──────────────────────────────────────
async function handleApprove(payload) {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const userId = payload.user?.id;

  const pending = pendingTasks.get(messageTs);
  if (!pending) {
    await postMessage(channel, ':x: Task list expired or already processed. Please run /transcribe again.', { threadTs: messageTs });
    return;
  }

  // Remove from pending
  pendingTasks.delete(messageTs);

  // Create tasks in ClickUp
  await postMessage(channel, ':rocket: Creating tasks in ClickUp...', { threadTs: messageTs });
  const results = await createAllTasks(pending.tasks);

  // Post confirmation
  const confirmBlocks = buildConfirmationBlocks(results);
  await postMessage(channel, `Tasks created by <@${userId}>`, { threadTs: messageTs, blocks: confirmBlocks });

  // Update original message to remove buttons
  const updatedBlocks = payload.message.blocks.filter(b => b.block_id !== 'task_actions');
  updatedBlocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `:white_check_mark: *Approved* by <@${userId}> | ${results.filter(r => r.success).length} task(s) created` }],
  });
  await updateMessage(channel, messageTs, 'Meeting Tasks — Approved', updatedBlocks);
}

// ── REJECT TASKS ───────────────────────────────────────
async function handleReject(payload) {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const userId = payload.user?.id;

  pendingTasks.delete(messageTs);

  // Update original message to remove buttons and show rejection
  const updatedBlocks = (payload.message?.blocks || []).filter(b => b.block_id !== 'task_actions');
  updatedBlocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `:no_entry_sign: *Rejected* by <@${userId}>` }],
  });
  await updateMessage(channel, messageTs, 'Meeting Tasks — Rejected', updatedBlocks);
}

// Export for nudge cron access
module.exports.pendingTasks = pendingTasks;
