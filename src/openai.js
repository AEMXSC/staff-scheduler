const ENDPOINT = 'https://adobedssopen.openai.azure.com/openai/v1/chat/completions';

// `days` from the live data (per request) constrains write targets to real
// day values -- structurally prevents the model shoving something like
// "conference" into a day field.
export function buildTools(days) {
  const dayField = {
    type: 'string',
    enum: days,
    description: 'One specific day. Never pass anything other than one of the listed values.',
  };

  return [
    {
      type: 'function',
      function: {
        name: 'run_sql',
        description: 'Answer any read-only question about the schedule by composing ONE SQLite SELECT. '
          + 'Use this for every factual/analytical question (who/when/counts/distinct/durations/gaps/overlaps/'
          + 'rankings). Do the filtering, counting, sorting, and grouping in SQL -- never eyeball or count yourself.',
        parameters: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'A single read-only SQLite SELECT (a leading WITH CTE is fine). No INSERT/UPDATE/DELETE, no semicolons.' },
          },
          required: ['sql'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'reassign_station',
        description: 'Propose moving a staff member to a different station on a given day. Only proposes -- a human confirms before anything is written.',
        parameters: {
          type: 'object',
          properties: {
            staff_name: { type: 'string' },
            day: dayField,
            new_station: { type: 'string' },
          },
          required: ['staff_name', 'day', 'new_station'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'swap_people',
        description: "Propose swapping two staff members' station assignments on a given day. Only proposes -- a human confirms before anything is written.",
        parameters: {
          type: 'object',
          properties: {
            staff_name_a: { type: 'string' },
            staff_name_b: { type: 'string' },
            day: dayField,
          },
          required: ['staff_name_a', 'staff_name_b', 'day'],
        },
      },
    },
  ];
}

export async function callAzureOpenAI(env, messages, tools) {
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.AZURE_OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.AZURE_OPENAI_DEPLOYMENT,
      messages,
      tools,
    }),
  });
  if (!resp.ok) throw new Error(`Azure OpenAI HTTP ${resp.status}`);
  return resp.json();
}
