// ============================================================
// SLACK HELPERS — Messages, modals, interactive elements
// ============================================================

const SLACK_API = 'https://slack.com/api';

async function slackFetch(method, body) {
  const token = process.env.SLACK_BOT_TOKEN;
  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!data.ok) console.error(`Slack ${method} error:`, data.error);
  return data;
}

async function joinChannel(channel) {
  return slackFetch('conversations.join', { channel });
}

async function postMessage(channel, text, options = {}) {
  return slackFetch('chat.postMessage', {
    channel,
    text,
    thread_ts: options.threadTs,
    blocks: options.blocks,
    mrkdwn: true,
  });
}

async function updateMessage(channel, ts, text, blocks) {
  return slackFetch('chat.update', { channel, ts, text, blocks });
}

async function openModal(triggerId, view) {
  return slackFetch('views.open', { trigger_id: triggerId, view });
}

// Build the transcript paste modal
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

// Build the task list message with Approve/Reject buttons
function buildTaskListBlocks(summary, tasks, submitterId) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Meeting Tasks Extracted' },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary:* ${summary}` },
    },
    { type: 'divider' },
  ];

  tasks.forEach((task, i) => {
    const uncertain = task.uncertain ? ' :warning:' : '';
    const dupe = task.possibleDuplicate ? ' :eyes: _possible duplicate_' : '';
    const priority = task.priority === 'urgent' ? ':red_circle:' :
                     task.priority === 'high' ? ':orange_circle:' :
                     task.priority === 'normal' ? ':white_circle:' : ':large_blue_circle:';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${priority} *${i + 1}. ${task.title}*${dupe}\n${task.description}\n_Assignee:_ ${task.assignee}${uncertain} | _Due:_ ${task.dueDate} | _Priority:_ ${task.priority}`,
      },
    });
  });

  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Submitted by <@${submitterId}> | ${tasks.length} task(s) extracted` }],
    },
    {
      type: 'actions',
      block_id: 'task_actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve & Create Tasks' },
          style: 'primary',
          action_id: 'approve_tasks',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject' },
          style: 'danger',
          action_id: 'reject_tasks',
        },
      ],
    }
  );

  return blocks;
}

// Build the confirmation message after tasks are created
function buildConfirmationBlocks(results) {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  let text = `:white_check_mark: *${successful.length} task(s) created in ClickUp!*\n\n`;

  successful.forEach(r => {
    text += `• ${r.task}`;
    if (r.url) text += ` — <${r.url}|View>`;
    text += '\n';
  });

  if (failed.length > 0) {
    text += `\n:x: *${failed.length} task(s) failed:*\n`;
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
  buildTaskListBlocks,
  buildConfirmationBlocks,
};
