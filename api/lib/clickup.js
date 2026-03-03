// ============================================================
// CLICKUP — Task creation and dedup checking
// ============================================================

const QUICK_TODOS_LIST_ID = '901815203192';
const CLICKUP_API = 'https://api.clickup.com/api/v2';

const PRIORITY_MAP = { urgent: 1, high: 2, normal: 3, low: 4 };

async function clickupFetch(path, options = {}) {
  const token = process.env.CLICKUP_API_TOKEN;
  const resp = await fetch(`${CLICKUP_API}${path}`, {
    ...options,
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  return resp.json();
}

async function getRecentTasks() {
  try {
    const data = await clickupFetch(`/list/${QUICK_TODOS_LIST_ID}/task?page=0&order_by=created&reverse=true`);
    return data.tasks || [];
  } catch (err) {
    console.error('ClickUp getRecentTasks error:', err.message);
    return [];
  }
}

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

async function createAllTasks(tasks) {
  const results = [];
  for (const task of tasks) {
    try {
      const result = await createTask(task);
      results.push({ success: true, task: task.title, id: result.id, url: result.url });
    } catch (err) {
      results.push({ success: false, task: task.title, error: err.message });
    }
  }
  return results;
}

async function checkForDuplicates(tasks) {
  const recentTasks = await getRecentTasks();
  const recentNames = recentTasks.map(t => t.name.toLowerCase());

  return tasks.map(task => ({
    ...task,
    possibleDuplicate: recentNames.some(name =>
      name.includes(task.title.toLowerCase()) || task.title.toLowerCase().includes(name)
    ),
  }));
}

module.exports = { createTask, createAllTasks, getRecentTasks, checkForDuplicates, QUICK_TODOS_LIST_ID };
