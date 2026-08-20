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
        description: 'Propose changing WHICH STATION/role a person is assigned to on a day. Use ONLY for station changes, never for time changes. Only proposes -- a human confirms before anything is written.',
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
    {
      type: 'function',
      function: {
        name: 'add_shift',
        description: 'Propose adding a NEW shift for someone on a day. Only proposes -- a human confirms before anything is written.',
        parameters: {
          type: 'object',
          properties: {
            staff_name: { type: 'string' },
            day: dayField,
            start_time: { type: 'string', description: "Start as 'HH:MM' 24-hour, e.g. 14:30" },
            end_time: { type: 'string', description: "End as 'HH:MM' 24-hour" },
            station: { type: 'string' },
            is_floater: { type: 'boolean', description: 'true if this is a backup/floater slot' },
          },
          required: ['staff_name', 'day', 'start_time', 'end_time', 'station'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_shift',
        description: 'Propose removing an existing shift. If the person has several shifts that day, pass station and/or start_time to pick which one. Only proposes -- a human confirms.',
        parameters: {
          type: 'object',
          properties: {
            staff_name: { type: 'string' },
            day: dayField,
            station: { type: 'string', description: 'optional, to disambiguate which shift' },
            start_time: { type: 'string', description: "optional current 'HH:MM' to disambiguate" },
          },
          required: ['staff_name', 'day'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_shift_time',
        description: 'Propose changing the HOURS (start and/or end time) of an existing shift, keeping the same person, day, and station. Use this whenever the user changes a time / when someone starts or ends. Pass station and/or the current start_time to pick which shift. Only proposes -- a human confirms.',
        parameters: {
          type: 'object',
          properties: {
            staff_name: { type: 'string' },
            day: dayField,
            station: { type: 'string', description: 'optional, to disambiguate which shift' },
            start_time: { type: 'string', description: "optional CURRENT 'HH:MM' to disambiguate which shift" },
            new_start_time: { type: 'string', description: "new start 'HH:MM' 24-hour" },
            new_end_time: { type: 'string', description: "new end 'HH:MM' 24-hour" },
          },
          required: ['staff_name', 'day', 'new_start_time', 'new_end_time'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'coverage_by_slot',
        description: 'Read-only: return per-30-minute-slot headcount for a day. Use this for "which hours/times are thinnest or busiest on the floor" -- then reason over the returned slots.',
        parameters: {
          type: 'object',
          properties: { day: dayField },
          required: ['day'],
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
