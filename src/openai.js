const ENDPOINT = 'https://adobedssopen.openai.azure.com/openai/v1/chat/completions';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'query_schedule',
      description: "Query the staff schedule -- read-only. Always use this for factual questions "
        + "(who/when/which station, 'first'/'last'/earliest/latest, counts, floaters) instead of "
        + 'guessing or counting yourself; the tool computes exact answers, you should not.',
      parameters: {
        type: 'object',
        properties: {
          staff_name: { type: 'string', description: 'Filter by staff name (partial match)' },
          day: { type: 'string' },
          station: { type: 'string', description: 'Filter by station (partial match)' },
          is_floater: { type: 'boolean', description: 'true = only floater/backup rows, false = only primary rows, omit = both' },
          sort_by: { type: 'string', enum: ['start_time', 'end_time'], description: "Set this to find the 'first'/earliest or 'last'/latest shift" },
          order: { type: 'string', enum: ['asc', 'desc'], description: "'asc' for earliest/first (default), 'desc' for latest/last" },
          limit: { type: 'integer', description: "Cap the number of rows returned after sorting -- e.g. 1 for 'who is first'" },
          count_only: { type: 'boolean', description: "If true, return just the count of matching rows -- use for 'how many' questions" },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reassign_station',
      description: 'Propose moving a staff member to a different station on a given day. Only proposes the change -- a human confirms it separately before anything is written.',
      parameters: {
        type: 'object',
        properties: {
          staff_name: { type: 'string' },
          day: { type: 'string' },
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
      description: "Propose swapping two staff members' station assignments on a given day. Only proposes the change -- a human confirms it separately before anything is written.",
      parameters: {
        type: 'object',
        properties: {
          staff_name_a: { type: 'string' },
          staff_name_b: { type: 'string' },
          day: { type: 'string' },
        },
        required: ['staff_name_a', 'staff_name_b', 'day'],
      },
    },
  },
];

export async function callAzureOpenAI(env, messages) {
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.AZURE_OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.AZURE_OPENAI_DEPLOYMENT,
      messages,
      tools: TOOLS,
    }),
  });
  if (!resp.ok) throw new Error(`Azure OpenAI HTTP ${resp.status}`);
  return resp.json();
}
