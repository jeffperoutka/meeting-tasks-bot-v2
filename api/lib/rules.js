// ============================================================
// RULES ENGINE — Training rules with KV + env var + default fallback
// ============================================================

let rulesCache = null;
let lastFetched = 0;
const CACHE_TTL = 60000;

const DEFAULT_RULES = [
  // Add built-in rules here:
  // { rule: 'Description of rule', category: 'process', addedBy: 'system', addedAt: '2024-01-01', sourceMessage: 'Built-in' }
];

async function loadRules() {
  if (rulesCache && Date.now() - lastFetched < CACHE_TTL) return rulesCache;

  // Try Vercel KV first
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      const resp = await fetch(process.env.KV_REST_API_URL + '/get/meeting-tasks-bot-v2_rules', {
        headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN }
      });
      const data = await resp.json();
      if (data.result) {
        rulesCache = JSON.parse(data.result);
        lastFetched = Date.now();
        return rulesCache;
      }
    }
  } catch (err) { console.error('KV load error:', err.message); }

  // Try env var fallback
  if (process.env.MEETING_TASKS_BOT_V2_RULES) {
    try {
      rulesCache = JSON.parse(process.env.MEETING_TASKS_BOT_V2_RULES);
      lastFetched = Date.now();
      return rulesCache;
    } catch (err) { console.error('Rules env parse error:', err.message); }
  }

  rulesCache = [...DEFAULT_RULES];
  lastFetched = Date.now();
  return rulesCache;
}

async function saveRules(rules) {
  rulesCache = rules;
  lastFetched = Date.now();
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      await fetch(process.env.KV_REST_API_URL + '/set/meeting-tasks-bot-v2_rules', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: JSON.stringify(rules) })
      });
      return;
    }
  } catch (err) { console.error('KV save error:', err.message); }
  console.log('Rules (no KV):', JSON.stringify(rules));
}

async function getTrainingRules() { return loadRules(); }

async function addTrainingRule(rule) {
  const rules = await loadRules();
  rules.push(rule);
  await saveRules(rules);
  return rules;
}

async function removeTrainingRule(index) {
  const rules = await loadRules();
  if (index >= 0 && index < rules.length) rules.splice(index, 1);
  await saveRules(rules);
  return rules;
}

async function listRulesFormatted() {
  const rules = await loadRules();
  if (rules.length === 0) return 'No rules configured yet.';
  let formatted = '\u{1F4DA} *Rules*\n\n';
  rules.forEach((r, i) => {
    const source = r.addedBy === 'system' ? '(built-in)' : '(<@' + r.addedBy + '>)';
    formatted += (i + 1) + '. ' + r.rule + ' ' + source + '\n';
  });
  return formatted;
}

module.exports = { getTrainingRules, addTrainingRule, removeTrainingRule, listRulesFormatted, DEFAULT_RULES };
