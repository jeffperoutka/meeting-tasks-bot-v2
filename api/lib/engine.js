// ============================================================
// ENGINE — Claude-powered task extraction from Fathom transcripts
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

  // Strip markdown code fences if Claude adds them
  const cleaned = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse Claude response:', content);
    throw new Error('Could not parse task extraction results');
  }
}

module.exports = { extractTasksFromTranscript, TEAM_MEMBERS };
