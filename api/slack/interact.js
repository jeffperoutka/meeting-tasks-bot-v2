// ============================================================
// INTERACTION HANDLER — Modal submissions, edit/remove, create all
// ============================================================
const { waitUntil } = require('@vercel/functions');
const {
  joinChannel, postMessage, updateMessage,
  openModal, buildEditTaskModal, buildTaskListBlocks, buildConfirmationBlocks,
} = require('../lib/slack');
const { extractTasksFromTranscript, semanticDedup } = require('../lib/engine');
const { processAllTasks, getExistingTasks } = require('../lib/clickup');

// In-memory store for pending task lists (keyed by message ts)
// Each entry: { tasks: [...], summary, submittedBy, channel, submittedAt }
const pendingTasks = new Map();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload;
  try {
    const raw = req.body?.payload || req.body;
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.error('Failed to parse interaction payload:', err);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const { type } = payload;

  // ── MODAL SUBMISSIONS ──────────────────────────────────
  if (type === 'view_submission') {
    const callbackId = payload.view?.callback_id;

    if (callbackId === 'transcript_submit') {
      res.status(200).json({ response_action: 'clear' });
      waitUntil(handleTranscriptSubmission(payload));
      return;
    }

    if (callbackId === 'edit_task_submit') {
      res.status(200).json({ response_action: 'clear' });
      waitUntil(handleEditTaskSubmission(payload));
      return;
    }

    return res.status(200).json({ response_action: 'clear' });
  }

  // ── BUTTON CLICKS ──────────────────────────────────────
  if (type === 'block_actions') {
    const action = payload.actions?.[0];
    if (!action) return res.status(200).json({ ok: true });

    const actionId = action.action_id;

    // Respond immediately (Slack 3s requirement)
    res.status(200).json({ ok: true });

    // Edit task — opens modal
    if (actionId.startsWith('edit_task_')) {
      waitUntil(handleEditTask(payload, action));
      return;
    }

    // Remove task
    if (actionId.startsWith('remove_task_')) {
      waitUntil(handleRemoveTask(payload, action));
      return;
    }

    // Create all remaining tasks
    if (actionId === 'create_all_tasks') {
      waitUntil(handleCreateAll(payload));
      return;
    }

    // Reject all
    if (actionId === 'reject_tasks') {
      waitUntil(handleReject(payload));
      return;
    }

    return;
  }

  return res.status(200).json({ ok: true });
};

// ── TRANSCRIPT SUBMISSION ────────────────────────────────
async function handleTranscriptSubmission(payload) {
  const userId = payload.user?.id;
  const channel = process.env.SLACK_CHANNEL_ID || 'C0AJ2HVFQJF';
  const transcript = payload.view?.state?.values?.transcript_block?.transcript_input?.value || '';

  if (!transcript.trim()) {
    await postMessage(channel, '❌ Empty transcript submitted. Please try again.');
    return;
  }

  // Ensure bot is in the channel
  const joinResult = await joinChannel(channel);
  if (!joinResult.ok && joinResult.error !== 'already_in_channel') {
    console.warn('Could not join channel:', joinResult.error);
  }

  const processingMsg = await postMessage(channel, '⏳ Extracting tasks from transcript...');

  if (!processingMsg.ok) {
    console.error('Failed to post processing message:', processingMsg.error);
    try {
      await postMessage(userId, `❌ Meeting Task Bot couldn't post to <#${channel}>. Please invite the bot with \`/invite @Meeting Task Bot\``);
    } catch (dmErr) {
      console.error('Fallback DM also failed:', dmErr.message);
    }
    return;
  }

  const processingTs = processingMsg.ts;

  try {
    // Step 1: Extract tasks from transcript
    await updateMessage(channel, processingTs, '⏳ Extracting tasks from transcript...', [
      { type: 'section', text: { type: 'mrkdwn', text: '⏳ *Step 1/2:* Extracting tasks from transcript...' } },
    ]);

    const result = await extractTasksFromTranscript(transcript);
    const { summary, tasks } = result;

    if (!tasks || tasks.length === 0) {
      await updateMessage(channel, processingTs, '🤷 No actionable tasks found.', [
        { type: 'section', text: { type: 'mrkdwn', text: `🤷 *No actionable tasks found.*\n\n*Summary:* ${summary || 'N/A'}` } },
      ]);
      return;
    }

    // Step 2: Cross-reference with existing ClickUp tasks
    await updateMessage(channel, processingTs, '⏳ Cross-referencing with ClickUp...', [
      { type: 'section', text: { type: 'mrkdwn', text: `⏳ *Step 2/2:* Found ${tasks.length} tasks. Cross-referencing with existing ClickUp tasks...` } },
    ]);

    let tasksWithDedup;
    try {
      const existingTasks = await getExistingTasks();
      console.log(`Fetched ${existingTasks.length} existing ClickUp tasks`);
      tasksWithDedup = await semanticDedup(tasks, existingTasks);
    } catch (dedupErr) {
      console.error('Dedup step failed, continuing without dedup:', dedupErr.message);
      tasksWithDedup = tasks.map(t => ({ ...t, matchType: 'new', existingTaskId: null, existingTaskName: null, existingTaskUrl: null }));
    }

    // Build the interactive task list
    const blocks = buildTaskListBlocks(summary, tasksWithDedup, userId);

    await updateMessage(channel, processingTs, `📋 Meeting Tasks — ${tasks.length} extracted`, blocks);

    // Store for later
    pendingTasks.set(processingTs, {
      tasks: tasksWithDedup,
      summary,
      submittedBy: userId,
      channel,
      submittedAt: Date.now(),
    });

    console.log(`Stored ${tasks.length} pending tasks under ts=${processingTs} (${tasksWithDedup.filter(t => t.matchType === 'update').length} matches)`);

  } catch (err) {
    console.error('Transcript processing error:', err);
    if (processingTs) {
      await updateMessage(channel, processingTs, `❌ Error: ${err.message}`, [
        { type: 'section', text: { type: 'mrkdwn', text: `❌ *Error extracting tasks:* ${err.message}\n\nPlease try again with /transcribe.` } },
      ]);
    }
  }
}

// ── EDIT TASK (open modal) ───────────────────────────────
async function handleEditTask(payload, action) {
  const messageTs = payload.message?.ts;
  const taskIndex = parseInt(action.value);
  const triggerId = payload.trigger_id;

  const pending = pendingTasks.get(messageTs);
  if (!pending) return;

  const task = pending.tasks[taskIndex];
  if (!task || task._removed) return;

  const modal = buildEditTaskModal(task, taskIndex, messageTs);
  await openModal(triggerId, modal);
}

// ── EDIT TASK SUBMISSION ─────────────────────────────────
async function handleEditTaskSubmission(payload) {
  const meta = JSON.parse(payload.view?.private_metadata || '{}');
  const { taskIndex, messageTs } = meta;

  const pending = pendingTasks.get(messageTs);
  if (!pending) return;

  const values = payload.view?.state?.values;

  // Extract edited values
  const newTitle = values?.edit_title?.title_input?.value;
  const newDescription = values?.edit_description?.description_input?.value;
  const assigneeValue = values?.edit_assignee?.assignee_input?.selected_option?.value; // "Name|clickupId"
  const newDueDate = values?.edit_due_date?.due_date_input?.selected_date;
  const newPriority = values?.edit_priority?.priority_input?.selected_option?.value;

  // Parse assignee
  let assigneeName, assigneeId;
  if (assigneeValue) {
    const parts = assigneeValue.split('|');
    assigneeName = parts[0];
    assigneeId = parts[1];
  }

  // Update the task in memory
  const task = pending.tasks[taskIndex];
  if (newTitle) task.title = newTitle;
  if (newDescription !== undefined) task.description = newDescription;
  if (assigneeName) { task.assignee = assigneeName; task.assigneeId = assigneeId; }
  if (newDueDate) task.dueDate = newDueDate;
  if (newPriority) task.priority = newPriority;

  // Mark as edited
  task._edited = true;

  // Rebuild and update the message
  const blocks = buildTaskListBlocks(pending.summary, pending.tasks, pending.submittedBy);
  await updateMessage(pending.channel, messageTs, `📋 Meeting Tasks — updated`, blocks);

  console.log(`Task ${taskIndex} edited: "${task.title}"`);
}

// ── REMOVE TASK ──────────────────────────────────────────
async function handleRemoveTask(payload, action) {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const taskIndex = parseInt(action.value);

  const pending = pendingTasks.get(messageTs);
  if (!pending) return;

  // Mark as removed (soft delete so indices stay stable)
  pending.tasks[taskIndex]._removed = true;

  // Rebuild and update the message
  const blocks = buildTaskListBlocks(pending.summary, pending.tasks, pending.submittedBy);
  const activeCount = pending.tasks.filter(t => !t._removed).length;
  await updateMessage(channel, messageTs, `📋 Meeting Tasks — ${activeCount} remaining`, blocks);

  console.log(`Task ${taskIndex} removed: "${pending.tasks[taskIndex].title}"`);
}

// ── CREATE ALL TASKS ─────────────────────────────────────
async function handleCreateAll(payload) {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const userId = payload.user?.id;

  const pending = pendingTasks.get(messageTs);
  if (!pending) {
    await postMessage(channel, '❌ Task list expired or already processed. Please run /transcribe again.', { threadTs: messageTs });
    return;
  }

  // Get only active (non-removed) tasks
  const activeTasks = pending.tasks.filter(t => !t._removed);

  if (activeTasks.length === 0) {
    await postMessage(channel, '❌ No tasks remaining. All were removed.', { threadTs: messageTs });
    pendingTasks.delete(messageTs);
    return;
  }

  pendingTasks.delete(messageTs);

  const newCount = activeTasks.filter(t => t.matchType !== 'update').length;
  const updateCount = activeTasks.filter(t => t.matchType === 'update').length;

  let progressText = `🚀 Processing ${activeTasks.length} task(s)`;
  if (updateCount > 0) progressText += ` (${newCount} new, ${updateCount} updates)`;
  progressText += '...';

  await postMessage(channel, progressText, { threadTs: messageTs });

  // Process all tasks (create new + update existing)
  const results = await processAllTasks(activeTasks);

  // Post confirmation in thread
  const confirmBlocks = buildConfirmationBlocks(results);
  await postMessage(channel, `Tasks processed by <@${userId}>`, { threadTs: messageTs, blocks: confirmBlocks });

  // Update original message — strip action buttons, show done state
  const cleanBlocks = stripActionBlocks(payload.message.blocks);
  const successCount = results.filter(r => r.success).length;
  cleanBlocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `✅ *Done* by <@${userId}> | ${successCount} task(s) processed`,
    }],
  });
  await updateMessage(channel, messageTs, '📋 Meeting Tasks — Done', cleanBlocks);
}

// ── REJECT ALL ───────────────────────────────────────────
async function handleReject(payload) {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const userId = payload.user?.id;

  pendingTasks.delete(messageTs);

  const cleanBlocks = stripActionBlocks(payload.message.blocks);
  cleanBlocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `🚫 *Rejected* by <@${userId}>` }],
  });
  await updateMessage(channel, messageTs, '📋 Meeting Tasks — Rejected', cleanBlocks);
}

// Helper: remove all action blocks
function stripActionBlocks(blocks) {
  return (blocks || []).filter(b => b.type !== 'actions');
}

module.exports.pendingTasks = pendingTasks;
