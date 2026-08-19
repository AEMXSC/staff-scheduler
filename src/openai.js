const ENDPOINT = 'https://adobedssopen.openai.azure.com/openai/v1/chat/completions';

// `days` comes from the actual schedule data (computed per request in
// worker.js), not hardcoded -- an enum constraint is a much stronger
// guardrail than a text description: it makes it structurally impossible
// for the model to pass something like "conference" as a day value
// (observed live: "during conference" got misread as day="conference",
// which then matched zero rows and silently looked like "no data found").
export function buildTools(days) {
  const dayField = {
    type: 'string',
    enum: days,
    description: 'One specific day. Omit entirely when the question is about the whole event/conference, not one day -- never pass anything other than one of the listed values.',
  };

  return [
    {
      type: 'function',
      function: {
        name: 'query_schedule',
        description: "Query the staff schedule -- read-only. Always use this for factual questions "
          + "(who/when/which station, 'first'/'last'/earliest/latest, counts, floaters, 'who has the "
          + "most/fewest shifts') instead of guessing, counting, or ranking yourself; the tool computes "
          + 'exact answers, you should not.',
        parameters: {
          type: 'object',
          properties: {
            staff_name: { type: 'string', description: "Filter by staff name (partial match, e.g. 'Andrew' matches 'Andrew Hochradel')" },
            day: dayField,
            station: { type: 'string', description: 'Filter by station (partial match)' },
            is_floater: { type: 'boolean', description: 'true = only floater/backup rows, false = only primary rows, omit = both' },
            sort_by: { type: 'string', enum: ['start_time', 'end_time'], description: "Set this to find the 'first'/earliest or 'last'/latest shift" },
            order: { type: 'string', enum: ['asc', 'desc'], description: "'asc' for earliest/first/fewest (default), 'desc' for latest/last/most" },
            limit: { type: 'integer', description: "Cap the number of rows/groups returned after sorting -- e.g. 1 for 'who is first' or 'who has the most shifts'" },
            count_only: { type: 'boolean', description: "If true, return just the count of matching rows -- use for 'how many shifts does X have' questions" },
            group_by: { type: 'string', enum: ['staff_name'], description: "Group matching rows by this field and count them -- use for 'who has the most/fewest shifts' questions, combined with order+limit" },
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
        description: "Propose swapping two staff members' station assignments on a given day. Only proposes the change -- a human confirms it separately before anything is written.",
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
