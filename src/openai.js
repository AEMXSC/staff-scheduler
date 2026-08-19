const ENDPOINT = 'https://adobedssopen.openai.azure.com/openai/v1/chat/completions';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'query_schedule',
      description: "Look up who's assigned to a station, day, or person in the staff schedule. Read-only.",
      parameters: {
        type: 'object',
        properties: {
          staff_name: { type: 'string' },
          day: { type: 'string' },
          station: { type: 'string' },
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
