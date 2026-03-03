// ============================================================
// SLACK HELPERS — Messages, modals, interactive elements
// ============================================================

const SLACK_API = 'https://slack.com/api';

const { TEAM_MEMBERS } = require('./engine');

async function slackFetch(method, body) {
  const token = process.env.SLACK_BOT_TOKEN;
  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!data.ok) {
    console.error(`Slack ${method} error:`, data.error, JSON.stringify(data).substring(0, 500));
  }
  return data;
}

async function joinChannel(channel) {
  return slackFetch('conversations.join', { channel });
}

async function postMessage(channel, text, options = {}) {
  return slackFetch('chat.postMessage', {
    channel, text,
    thread_ts: options.threadTs,
    blocks: options.blocks,
    mrkdwn: true,
  });
}

async function updateMessage(channel, ts, text, blocks) {
  const result = await slackFetch('chat.update', { channel, ts, text, blocks });
  if (!result.ok) {
    // Throw so callers can catch and handle
    const err = new Error(`chat.update failed: ${result.error}`);
    err.slackError = result.error;
    throw err;
  }
  return result;
}

async function openModal(triggerId, view) {
  return slackFetch('views.open', { trigger_id: triggerId, view });
}

// ── TRANSCRIPT PASTE MODAL ────────────────────────────────
function buildTranscriptModal() {
  return {
    type: 'modal',
    callback_id: 'transcript_submit',
    title: { type: 'plain_text', text: 'Paste Transcript' },
    submit: { type: 'plain_text', text: 'Extract Tasks' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'transcript_block',
        label: { type: 'plain_text', text: 'Fathom Meeting Transcript' },
        element: {
          type: 'plain_text_input',
          action_id: 'transcript_input',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Paste your full Fathom transcript here...' },
        },
      },
    ],
  };
}

// ── EDIT TASK MODAL ───────────────────────────────────────
// Pre-filled modal so user can tweak any field
function buildEditTaskModal(task, taskIndex, messageTs) {
  const teamOptions = TEAM_MEMBERS.map(m => ({
    text: { type: 'plain_text', text: `${m.name} (${m.role})` },
    value: `${m.name}|${m.clickupId}`,
  }));

  const priorityOptions = [
    { text: { type: 'plain_text', text: '🔴 Urgent' }, value: 'urgent' },
    { text: { type: 'plain_text', text: '🟠 High' }, value: 'high' },
    { text: { type: 'plain_text', text: '⚪ Normal' }, value: 'normal' },
    { text: { type: 'plain_text', text: '🔵 Low' }, value: 'low' },
  ];

  // Find current assignee option
  const currentAssignee = teamOptions.find(o => o.value.startsWith(task.assignee + '|'));
  const currentPriority = priorityOptions.find(o => o.value === task.priority);

  return {
    type: 'modal',
    callback_id: 'edit_task_submit',
    private_metadata: JSON.stringify({ taskIndex, messageTs }),
    title: { type: 'plain_text', text: 'Edit Task' },
    submit: { type: 'plain_text', text: 'Save Changes' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'edit_title',
        label: { type: 'plain_text', text: 'Task Title' },
        element: {
          type: 'plain_text_input',
          action_id: 'title_input',
          initial_value: task.title,
        },
      },
      {
        type: 'input',
        block_id: 'edit_description',
        label: { type: 'plain_text', text: 'Description' },
        element: {
          type: 'plain_text_input',
          action_id: 'description_input',
          multiline: true,
          initial_value: task.description || '',
        },
      },
      {
        type: 'input',
        block_id: 'edit_assignee',
        label: { type: 'plain_text', text: 'Assignee' },
        element: {
          type: 'static_select',
          action_id: 'assignee_input',
          options: teamOptions,
          ...(currentAssignee ? { initial_option: currentAssignee } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'edit_due_date',
        label: { type: 'plain_text', text: 'Due Date' },
        element: {
          type: 'datepicker',
          action_id: 'due_date_input',
          ...(task.dueDate ? { initial_date: task.dueDate } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'edit_priority',
        label: { type: 'plain_text', text: 'Priority' },
        element: {
          type: 'static_select',
          action_id: 'priority_input',
          options: priorityOptions,
          ...(currentPriority ? { initial_option: currentPriority } : {}),
        },
      },
    ],
  };
}

// ── TASK LIST MESSAGE ─────────────────────────────────
// Shows all tasks with Edit + Remove buttons per task, Create All at bottom
// CRITICAL: Slack has a 50 block limit per message.
// Normal mode: 2 blocks per task (section + actions) → max ~22 tasks
// Compact mode: 1 block per task (section with accessory button) → max ~44 tasks
function buildTaskListBlocks(summary, tasks, submitterId) {
  console.log(`buildTaskListBlocks: ${tasks.length} total, ${tasks.filter(t => !t._removed).length} active`);

  const MAX_BLOCKS = 50;
  const STRUCTURAL_BLOCKS = 6; // header + summary + divider + divider + context + final_actions

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📋 Meeting Tasks Extracted' },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary:* ${(summary || '').substring(0, 2900)}` },
    },
    { type: 'divider' },
  ];

  // Collect active tasks with their original indices
  const activeTasks = [];
  tasks.forEach((task, i) => {
    if (!task._removed) activeTasks.push({ task, index: i });
  });

  // Determine mode: compact (1 block/task) or normal (2 blocks/task)
  const blocksPerTask = activeTasks.length > 22 ? 1 : 2;
  const maxTasksToShow = Math.floor((MAX_BLOCKS - STRUCTURAL_BLOCKS) / blocksPerTask);
  const tasksToShow = activeTasks.slice(0, maxTasksToShow);
  const truncated = activeTasks.length > maxTasksToShow;

  tasksToShow.forEach(({ task, index: i }) => {
    const uncertain = task.uncertain ? ' ⚠️' : '';
    const priority = task.priority === 'urgent' ? '🔴' :
                     task.priority === 'high' ? '🟠' :
                     task.priority === 'normal' ? '⚪' : '🔵';

    let matchInfo = '';
    if (task.matchType === 'update') {
      matchInfo = ' 🔄';
    }

    // Truncate description to stay under Slack's 3000 char limit per text element
    const desc = (task.description || '').substring(0, 150);

    if (blocksPerTask === 1) {
      // Compact: section with accessory edit button (1 block)
      blocks.push({
        type: 'section',
        block_id: `task_desc_${i}`,
        text: {
          type: 'mrkdwn',
          text: `${priority} *${i + 1}. ${task.title}*${uncertain}${matchInfo}\n${desc}\n_→ ${task.assignee} | ${task.dueDate}_`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '✏️ Edit' },
          action_id: `edit_task_${i}`,
          value: String(i),
        },
      });
    } else {
      // Normal: section + actions (2 blocks)
      let fullMatchInfo = '';
      if (task.matchType === 'update') {
        const conf = task.matchConfidence === 'high' ? '🎯' : '🔍';
        const existingName = (task.existingTaskName || '').substring(0, 80);
        fullMatchInfo = `\n${conf} _Matches:_ <${task.existingTaskUrl}|${existingName}> → *update*`;
      }

      blocks.push({
        type: 'section',
        block_id: `task_desc_${i}`,
        text: {
          type: 'mrkdwn',
          text: `${priority} *${i + 1}. ${task.title}*${uncertain}\n${desc}\n_Assignee:_ ${task.assignee} | _Due:_ ${task.dueDate} | _Priority:_ ${task.priority}${fullMatchInfo}`,
        },
      });

      blocks.push({
        type: 'actions',
        block_id: `task_actions_${i}`,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✏️ Edit' },
            action_id: `edit_task_${i}`,
            value: String(i),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🗑️ Remove' },
            style: 'danger',
            action_id: `remove_task_${i}`,
            value: String(i),
          },
        ],
      });
    }
  });

  // Footer
  const activeCount = activeTasks.length;
  const updateCount = activeTasks.filter(({ task }) => task.matchType === 'update').length;
  const newCount = activeCount - updateCount;

  let footerText = `<@${submitterId}> | ${activeCount} task(s)`;
  if (updateCount > 0) {
    footerText += ` (${newCount} new, ${updateCount} updating existing)`;
  }
  if (truncated) {
    footerText += `\n⚠️ Showing ${tasksToShow.length} of ${activeCount} — all will be processed on Create All`;
  }
  footerText += '\nEdit tasks as needed, then hit *Create All*';

  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: footerText }],
    },
    {
      type: 'actions',
      block_id: 'final_actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: `🚀 Create All (${activeCount})` },
          style: 'primary',
          action_id: 'create_all_tasks',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject All' },
          style: 'danger',
          action_id: 'reject_tasks',
        },
      ],
    }
  );

  console.log(`buildTaskListBlocks: returning ${blocks.length} blocks (${blocksPerTask} per task, compact=${blocksPerTask === 1})`);
  return blocks;
}

// ── CONFIRMATION MESSAGE ──────────────────────────────────
function buildConfirmationBlocks(results) {
  const created = results.filter(r => r.success && r.action === 'created');
  const updated = results.filter(r => r.success && r.action === 'updated');
  const failed = results.filter(r => !r.success);

  let text = '';

  if (created.length > 0) {
    text += `✅ *${created.length} new task(s) created:*\n`;
    created.forEach(r => {
      text += `• ${r.task}`;
      if (r.url) text += ` — <${r.url}|View>`;
      text += '\n';
    });
    text += '\n';
  }

  if (updated.length > 0) {
    text += `🔄 *${updated.length} existing task(s) updated:*\n`;
    updated.forEach(r => {
      text += `• ${r.task} → updated <${r.url}|${r.existingTask}>`;
      text += '\n';
    });
    text += '\n';
  }

  if (failed.length > 0) {
    text += `❌ *${failed.length} task(s) failed:*\n`;
    failed.forEach(r => { text += `• ${r.task}: ${r.error}\n`; });
  }

  return [{ type: 'section', text: { type: 'mrkdwn', text } }];
}

module.exports = {
  joinChannel,
  postMessage,
  updateMessage,
  openModal,
  buildTranscriptModal,
  buildEditTaskModal,
  buildTaskListBlocks,
  buildConfirmationBlocks,
};
