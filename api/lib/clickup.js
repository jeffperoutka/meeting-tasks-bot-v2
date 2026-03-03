// ============================================================
// CLICKUP — Task creation, updates, and smart dedup handling
// ============================================================

const QUICK_TODOS_LIST_ID = '901815203192';
const CLICKUP_API = 'https://api.clickup.com/api/v2';

const PRIORITY_MAP = { urgent: 1, high: 2, normal: 3, low: 4 };

async function clickupFetch(path, options = {}) {
  const token = process.env.CLICKUP_API_TOKEN;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

  try {
    const resp = await fetch(`${CLICKUP_API}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    return resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Get all open tasks from the Quick To-do's list (for dedup matching)
async function getExistingTasks() {
  try {
    // Fetch open tasks (statuses: to do, in progress, etc. — not closed/done)
    const data = await clickupFetch(
      `/list/${QUICK_TODOS_LIST_ID}/task?page=0&order_by=created&reverse=true&subtasks=true&include_closed=false`
    );
    return data.tasks || [];
  } catch (err) {
    console.error('ClickUp getExistingTasks error:', err.message);
    return [];
  }
}

// Create a new task
async function createTask(task) {
  const dueTimestamp = task.dueDate ? new Date(task.dueDate + 'T17:00:00Z').getTime() : null;

  const body = {
    name: task.title,
    description: task.description || '',
    assignees: task.assigneeId ? [parseInt(task.assigneeId)] : [],
    priority: PRIORITY_MAP[task.priority] || 3,
    status: 'to do',
  };

  if (dueTimestamp) body.due_date = dueTimestamp;

  return clickupFetch(`/list/${QUICK_TODOS_LIST_ID}/task`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Update an existing task: add meeting context as comment + optionally update due date
async function updateExistingTask(task) {
  const taskId = task.existingTaskId;

  // 1. Post a comment with the meeting context
  const commentBody = {
    comment_text: `📋 *Meeting Update*\n\nThis task was re-mentioned in a meeting:\n\n> ${task.description}\n\n_Assignee from meeting:_ ${task.assignee} | _Priority:_ ${task.priority} | _Due date mentioned:_ ${task.dueDate}`,
    notify_all: false,
  };

  const commentResult = await clickupFetch(`/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify(commentBody),
  });

  // 2. Update due date if the meeting mentioned a newer one
  if (task.dueDate) {
    const dueTimestamp = new Date(task.dueDate + 'T17:00:00Z').getTime();
    await clickupFetch(`/task/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify({ due_date: dueTimestamp }),
    });
  }

  return {
    id: taskId,
    url: task.existingTaskUrl,
    commentId: commentResult?.id,
  };
}

// Process all tasks: create new ones, update existing matches
async function processAllTasks(tasks) {
  const results = [];

  for (const task of tasks) {
    try {
      if (task.matchType === 'update' && task.existingTaskId) {
        // Update existing task instead of creating duplicate
        const result = await updateExistingTask(task);
        results.push({
          success: true,
          action: 'updated',
          task: task.title,
          existingTask: task.existingTaskName,
          id: result.id,
          url: result.url,
        });
      } else {
        // Create new task
        const result = await createTask(task);
        results.push({
          success: true,
          action: 'created',
          task: task.title,
          id: result.id,
          url: result.url,
        });
      }
    } catch (err) {
      results.push({
        success: false,
        action: task.matchType === 'update' ? 'update_failed' : 'create_failed',
        task: task.title,
        error: err.message,
      });
    }
  }

  return results;
}

module.exports = {
  createTask,
  updateExistingTask,
  processAllTasks,
  getExistingTasks,
  QUICK_TODOS_LIST_ID,
};
