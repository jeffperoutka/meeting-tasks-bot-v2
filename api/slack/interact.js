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

  console.log(`[TRANSCRIPT] Starting — user=${userId}, channel=${channel}, length=${transcript.length}`);

  // Ensure bot is in the channel
  const joinResult = await joinChannel(channel);
  if (!joinResult.ok && joinResult.error !== 'already_in_channel') {
    console.warn('[TRANSCRIPT] Could not join channel:', joinResult.error);
  }

  const processingMsg = await postMessage(channel, '⏳ Extracting tasks from transcript...');

  if (!processingMsg.ok) {
    console.error('[TRANSCRIPT] Failed to post processing message:', processingMsg.error);
    try {
      await postMessage(userId, `❌ Meeting Task Bot couldn't post to <#${channel}>. Please invite the bot with \`/invite @Meeting Task Bot\``);
    } catch (dmErr) {
      console.error('[TRANSCRIPT] Fallback DM also failed:', dmErr.message);
    }
    return;
  }

  const processingTs = processingMsg.ts;
  console.log(`[TRANSCRIPT] Processing message posted: ts=${processingTs}`);

  try {
    // Step 1: Extract tasks from transcript
    console.log('[TRANSCRIPT] Step 1: Extracting tasks...');
    try {
      await updateMessage(channel, processingTs, '⏳ Extracting tasks from transcript...', [
        { type: 'section', text: { type: 'mrkdwn', text: '⏳ *Step 1/2:* Extracting tasks from transcript...' } },
      ]);
    } catch (updateErr) {
      console.warn('[TRANSCRIPT] Step 1 status update failed (non-fatal):', updateErr.message);
    }

    const result = await extractTasksFromTranscript(transcript);
    const { summary, tasks } = result;
    console.log(`[TRANSCRIPT] Step 1 complete: ${tasks?.length || 0} tasks extracted`);

    if (!tasks || tasks.length === 0) {
      try {
        await updateMessage(channel, processingTs, '🤷 No actionable tasks found.', [
          { type: 'section', text: { type: 'mrkdwn', text: `🤷 *No actionable tasks found.*\n\n*Summary:* ${summary || 'N/A'}` } },
        ]);
      } catch (e) {
        await postMessage(channel, `🤷 No actionable tasks found.\n*Summary:* ${summary || 'N/A'}`);
      }
      return;
    }

    // Step 2: Cross-reference with existing ClickUp tasks
    console.log('[TRANSCRIPT] Step 2: Cross-referencing with ClickUp...');
    try {
      await updateMessage(channel, processingTs, '⏳ Cross-referencing with ClickUp...', [
        { type: 'section', text: { type: 'mrkdwn', text: `⏳ *Step 2/2:* Found ${tasks.length} tasks. Cross-referencing with existing ClickUp tasks...` } },
      ]);
    } catch (updateErr) {
      console.warn('[TRANSCRIPT] Step 2 status update failed (non-fatal):', updateErr.message);
    }

    let tasksWithDedup;
    try {
      console.log('[TRANSCRIPT] Fetching existing ClickUp tasks...');
      const existingTasks = await getExistingTasks();
      console.log(`[TRANSCRIPT] Fetched ${existingTasks.length} existing ClickUp tasks`);

      if (existingTasks.length > 0) {
        console.log('[TRANSCRIPT] Running semantic dedup...');
        tasksWithDedup = await semanticDedup(tasks, existingTasks);
        console.log(`[TRANSCRIPT] Dedup complete: ${tasksWithDedup.filter(t => t.matchType === 'update').length} matches`);
      } else {
        console.log('[TRANSCRIPT] No existing tasks, skipping dedup');
        tasksWithDedup = tasks.map(t => ({ ...t, matchType: 'new', existingTaskId: null, existingTaskName: null, existingTaskUrl: null }));
      }
    } catch (dedupErr) {
      console.error('[TRANSCRIPT] Dedup failed, continuing without:', dedupErr.message);
      tasksWithDedup = tasks.map(t => ({ ...t, matchType: 'new', existingTaskId: null, existingTaskName: null, existingTaskUrl: null }));
    }

    // Build the interactive task list
    console.log('[TRANSCRIPT] Building task list blocks...');
    const blocks = buildTaskListBlocks(summary, tasksWithDedup, userId);
    console.log(`[TRANSCRIPT] Built ${blocks.length} blocks, updating message...`);

    try {
      await updateMessage(channel, processingTs, `📋 Meeting Tasks — ${tasks.length} extracted`, blocks);
      console.log('[TRANSCRIPT] Task list message updated successfully');
    } catch (updateErr) {
      console.error('[TRANSCRIPT] updateMessage failed:', updateErr.message);
      // Fallback: post as new message
      console.log('[TRANSCRIPT] Falling back to new message...');
      const fallbackMsg = await postMessage(channel, `📋 Meeting Tasks — ${tasks.length} extracted`, { blocks });
      if (!fallbackMsg.ok) {
        console.error('[TRANSCRIPT] Fallback postMessage also failed:', fallbackMsg.error);
        // Last resort: post plain text summary
        let plainText = `📋 *Meeting Tasks — ${tasks.length} extracted*\n\n*Summary:* ${summary}\n\n`;
        tasksWithDedup.forEach((t, i) => {
          plainText += `${i + 1}. *${t.title}* → ${t.assignee} (${t.priority}) due ${t.dueDate}\n`;
        });
        plainText += '\n⚠️ Interactive buttons unavailable. Please run /transcribe again.';
        await postMessage(channel, plainText);
        return;
      }
      // Update processingTs to the new message for pendingTasks
      if (fallbackMsg.ts) {
        pendingTasks.set(fallbackMsg.ts, {
          tasks: tasksWithDedup, summary, submittedBy: userId, channel, submittedAt: Date.now(),
        });
        console.log(`[TRANSCRIPT] Stored ${tasks.length} pending tasks under fallback ts=${fallbackMsg.ts}`);
        return;
      }
    }

    // Store for later button clicks
    pendingTasks.set(processingTs, {
      tasks: tasksWithDedup,
      summary,
      submittedBy: userId,
      channel,
      submittedAt: Date.now(),
    });

    console.log(`[TRANSCRIPT] ✅ Complete — ${tasks.length} tasks stored under ts=${processingTs}`);

  } catch (err) {
    console.error('[TRANSCRIPT] Fatal error:', err.message, err.stack);
    // Try to update the message with error
    try {
      await updateMessage(channel, processingTs, `❌ Error: ${err.message}`, [
        { type: 'section', text: { type: 'mrkdwn', text: `❌ *Error:* ${err.message}\n\nPlease try again with /transcribe.` } },
      ]);
    } catch (updateErr) {
      console.error('[TRANSCRIPT] Error update also failed:', updateErr.message);
      // Last resort: post error as new message
      await postMessage(channel, `❌ *Error processing transcript:* ${err.message}\n\nPlease try again with /transcribe.`);
    }
  }
}

// ── EDIT TASK (open modal) ───────────────────────────────
async function handleEditTask(payload, action) {
  const messageTs = payload.message?.ts;
  const taskIndex = parseInt(action.value);
  const triggerId = payload.trigger_id;

  const pending = pendingTasks.get(messageTs);
  if (!pending) {
    console.warn(`[EDIT] No pending tasks for ts=${messageTs}`);
    return;
  }

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
  try {
    await updateMessage(pending.channel, messageTs, `📋 Meeting Tasks — updated`, blocks);
  } catch (err) {
    console.error('[EDIT] Update message failed:', err.message);
  }

  console.log(`[EDIT] Task ${taskIndex} edited: "${task.title}"`);
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
  try {
    await updateMessage(channel, messageTs, `📋 Meeting Tasks — ${activeCount} remaining`, blocks);
  } catch (err) {
    console.error('[REMOVE] Update message failed:', err.message);
  }

  console.log(`[REMOVE] Task ${taskIndex} removed: "${pending.tasks[taskIndex].title}"`);
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
  try {
    await updateMessage(channel, messageTs, '📋 Meeting Tasks — Done', cleanBlocks);
  } catch (err) {
    console.error('[CREATE_ALL] Update message failed:', err.message);
  }
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
  try {
    await updateMessage(channel, messageTs, '📋 Meeting Tasks — Rejected', cleanBlocks);
  } catch (err) {
    console.error('[REJECT] Update message failed:', err.message);
  }
}

// Helper: remove all action blocks
function stripActionBlocks(blocks) {
  return (blocks || []).filter(b => b.type !== 'actions');
}

module.exports.pendingTasks = pendingTasks;
