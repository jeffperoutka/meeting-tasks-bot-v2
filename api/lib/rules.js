// ============================================================
// RULES ENGINE — Training rules with GitHub persistence
// ============================================================
// On cold start: read rules.json from repo via GitHub API.
// On add/remove: update in-memory + commit to GitHub (auto-deploys).
// No KV or external storage needed — just GITHUB_PAT env var.

const REPO = 'jeffperoutka/meeting-tasks-bot-v2';
const FILE_PATH = 'rules.json';

// In-memory cache
let rulesCache = null;
let lastFetched = 0;
const CACHE_TTL = 60000; // Re-read from GitHub every 60s max

// ── LOAD RULES ─────────────────────────────────────────
async function loadRules() {
  if (rulesCache && Date.now() - lastFetched < CACHE_TTL) return rulesCache;

  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    console.warn('[RULES] No GITHUB_PAT — using empty rules');
    rulesCache = [];
    lastFetched = Date.now();
    return rulesCache;
  }

  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (resp.ok) {
      const data = await resp.json();
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      rulesCache = JSON.parse(content);
      lastFetched = Date.now();
      console.log(`[RULES] Loaded ${rulesCache.length} rules from GitHub`);
    } else {
      console.log('[RULES] No rules.json in repo yet, starting empty');
      rulesCache = [];
      lastFetched = Date.now();
    }
  } catch (err) {
    console.error('[RULES] GitHub load error:', err.message);
    rulesCache = rulesCache || [];
    lastFetched = Date.now();
  }

  return rulesCache;
}

// ── SAVE RULES TO GITHUB ───────────────────────────────
async function saveRules(rules) {
  rulesCache = rules;
  lastFetched = Date.now();

  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    console.warn('[RULES] No GITHUB_PAT — rules only in memory');
    return;
  }

  try {
    // Get current file SHA (needed for updates)
    let sha;
    const getResp = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (getResp.ok) {
      const existing = await getResp.json();
      sha = existing.sha;
    }

    // Commit updated rules
    const content = Buffer.from(JSON.stringify(rules, null, 2)).toString('base64');
    const putResp = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `rules: ${rules.length} training rules (auto-commit)`,
        content,
        ...(sha ? { sha } : {}),
      }),
    });

    if (putResp.ok) {
      console.log(`[RULES] Committed ${rules.length} rules to GitHub`);
    } else {
      const err = await putResp.text();
      console.error('[RULES] GitHub commit failed:', putResp.status, err.substring(0, 200));
    }
  } catch (err) {
    console.error('[RULES] GitHub save error:', err.message);
  }
}

// ── PUBLIC API ─────────────────────────────────────────

async function getTrainingRules() {
  return loadRules();
}

async function addTrainingRule(rule) {
  const rules = await loadRules();
  rules.push(rule);
  await saveRules(rules);
  console.log(`[RULES] Added: "${rule.rule}" (${rules.length} total)`);
  return rules;
}

async function removeTrainingRule(index) {
  const rules = await loadRules();
  if (index < 0 || index >= rules.length) return rules;
  const removed = rules.splice(index, 1)[0];
  await saveRules(rules);
  console.log(`[RULES] Removed: "${removed.rule}" (${rules.length} remaining)`);
  return rules;
}

async function listRulesFormatted() {
  const rules = await loadRules();
  if (rules.length === 0) {
    return '📋 *No training rules yet.*\nReply to my messages with feedback to teach me!';
  }

  let text = `📋 *Training Rules (${rules.length}):*\n\n`;
  rules.forEach((r, i) => {
    const source = r.source === 'thread_feedback' ? '💬' : '📝';
    text += `${i + 1}. ${source} ${r.rule}\n`;
    text += `   _${r.category} | by <@${r.addedBy}>_\n`;
  });
  text += '\n_Use "meeting-tasks-bot-v2 remove rule N" to delete a rule._';
  return text;
}

// Returns rules formatted for injection into Claude prompts
async function getRulesForPrompt() {
  const rules = await loadRules();
  if (rules.length === 0) return '';

  let text = '\n\nTRAINING RULES (learned from team feedback — follow these strictly):\n';
  rules.forEach((r, i) => {
    text += `${i + 1}. ${r.rule}\n`;
  });
  return text;
}

module.exports = {
  getTrainingRules,
  addTrainingRule,
  removeTrainingRule,
  listRulesFormatted,
  getRulesForPrompt,
};
