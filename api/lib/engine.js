// ============================================================
// ENGINE — Claude-powered task extraction + semantic dedup
// ============================================================
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

// AEO Labs team members for assignment
const TEAM_MEMBERS = [
  { name: 'Sasha', clickupId: '107598606', role: 'SEO Specialist / QA' },
  { name: 'Hannah', clickupId: '107556476', role: 'Product Manager' },
  { name: 'Jeff', clickupId: '300808837', role: 'Co-founder / Operations' },
  { name: 'Aidan', clickupId: '107556471', role: 'Co-founder / Sales' },
];

function getEndOfWeekDate() {
  const now = new Date();
  const daysUntilFriday = (5 - now.getDay() + 7) % 7 || 7;
  const friday = new Date(now);
  friday.setDate(now.getDate() + daysUntilFriday);
  friday.setHours(17, 0, 0, 0);
  return friday.toISOString().split('T')[0];
}

async function extractTasksFromTranscript(transcript) {
  const endOfWeek = getEndOfWeekDate();
  const teamList = TEAM_MEMBERS.map(m => `- ${m.name} (${m.role})`).join('\n');

  const systemPrompt = `You are Meeting Tasks Bot for AEO Labs, an AI SEO agency.

Your task: Extract actionable tasks from a Fathom meeting transcript.

TEAM MEMBERS:
${teamList}

RULES:
1. Extract ONLY clear, actionable tasks — not discussion points or observations.
2. Each task needs: title, description, assignee, priority, due date.
3. Default due date: ${endOfWeek} (end of this week) unless a specific date is mentioned.
4. Assign tasks to team members based on context. If unclear, assign to the most likely person and flag with uncertain=true.
5. Priority levels: urgent, high, normal, low.
6. Create a brief 2-3 sentence meeting summary.
7. If the transcript mentions Fathom action items, prioritize those.
8. Parse speaker labels (e.g., "Jeff:", "Hannah:") to understand who committed to what.

OUTPUT FORMAT — respond with ONLY valid JSON, no markdown fences:
{
  "summary": "Brief 2-3 sentence meeting summary",
  "tasks": [
    {
      "title": "Short task title",
      "description": "What needs to be done and any context",
      "assignee": "Name",
      "assigneeId": "ClickUp user ID",
      "priority": "normal",
      "dueDate": "YYYY-MM-DD",
      "uncertain": false
    }
  ]
}

If uncertain about an assignee, set uncertain=true and pick the most likely person.
If no tasks are found, return an empty tasks array with just a summary.`;

  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Extract tasks from this meeting transcript:\n\n${transcript}` }]
  });

  const response = await stream.finalMessage();
  const content = response.content[0].text;
  const cleaned = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse Claude response:', content);
    throw new Error('Could not parse task extraction results');
  }
}

// ── TIMEOUT HELPER ─────────────────────────────────────
function withTimeout(promise, ms, label = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

// ── SEMANTIC DEDUP ──────────────────────────────────────
// Uses Claude to match extracted tasks against existing ClickUp tasks
async function semanticDedup(extractedTasks, existingTasks) {
  if (!existingTasks || existingTasks.length === 0) {
    console.log('No existing tasks to dedup against, marking all as new');
    return extractedTasks.map(t => ({ ...t, matchType: 'new', existingTaskId: null, existingTaskName: null, existingTaskUrl: null }));
  }

  // Cap existing tasks to 75 most recent to keep prompt manageable
  const cappedTasks = existingTasks.slice(0, 75);
  console.log(`Dedup: comparing ${extractedTasks.length} extracted vs ${cappedTasks.length} existing tasks (${existingTasks.length} total)`);

  // Build a concise list — name + status only (minimal tokens)
  const existingList = cappedTasks.map((t, i) => {
    return `[${i}] "${t.name}" (id: ${t.id})`;
  }).join('\n');

  const extractedList = extractedTasks.map((t, i) => {
    return `[${i}] "${t.title}" — ${t.description?.substring(0, 100) || ''}`;
  }).join('\n');

  const systemPrompt = `You are a task deduplication engine. Compare newly extracted meeting tasks against existing ClickUp tasks.

For each extracted task, determine if it semantically matches an existing task. A match means:
- The tasks refer to the same work item (even if worded differently)
- Examples: "Update Sprint 1 deck" matches "Send Sprint 1 v3 to Jeff"
- Examples: "Follow up on Phyto payment" matches "Get ETA on Phyto-Extractum payment"
- Be generous with matching — if they're about the same deliverable/action, it's a match

Respond with ONLY valid JSON, no markdown fences:
[
  {
    "extractedIndex": 0,
    "matchedExistingIndex": null,
    "confidence": "none"
  },
  {
    "extractedIndex": 1,
    "matchedExistingIndex": 3,
    "confidence": "high"
  }
]

confidence levels: "high" (clearly same task), "medium" (likely same), "none" (no match)
Set matchedExistingIndex to null if no match found.
Only match with confidence "high" or "medium" — don't force matches.`;

  try {
    // Use non-streaming create() with 60s timeout — much faster than streaming for structured output
    const response = await withTimeout(
      anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `EXISTING CLICKUP TASKS:\n${existingList}\n\nNEWLY EXTRACTED TASKS:\n${extractedList}`
        }]
      }),
      60000,
      'Claude dedup'
    );

    const content = response.content[0].text;
    const cleaned = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    const matches = JSON.parse(cleaned);

    console.log(`Dedup complete: ${matches.filter(m => m.matchedExistingIndex !== null).length} matches found`);

    // Merge match info into extracted tasks
    return extractedTasks.map((task, i) => {
      const match = matches.find(m => m.extractedIndex === i);
      if (match && match.matchedExistingIndex !== null && match.confidence !== 'none') {
        const existing = cappedTasks[match.matchedExistingIndex];
        return {
          ...task,
          matchType: 'update',
          matchConfidence: match.confidence,
          existingTaskId: existing.id,
          existingTaskName: existing.name,
          existingTaskUrl: existing.url,
        };
      }
      return { ...task, matchType: 'new', existingTaskId: null, existingTaskName: null, existingTaskUrl: null };
    });
  } catch (err) {
    console.error('Semantic dedup failed, treating all as new:', err.message);
    return extractedTasks.map(t => ({ ...t, matchType: 'new', existingTaskId: null, existingTaskName: null, existingTaskUrl: null }));
  }
}

module.exports = { extractTasksFromTranscript, semanticDedup, TEAM_MEMBERS };
