import { getSchedule, putSchedule } from './kv.js';
import {
  issueToken, requireAuth, isRateLimited, recordFailedAuth, clearFailedAuth,
} from './auth.js';
import { callAzureOpenAI } from './openai.js';
import {
  findRows, sortRows, planReassign, applyReassign, planSwap, applySwap,
} from './schedule-ops.js';

const SYSTEM_PROMPT = 'You are the scheduling assistant for a staff event schedule. '
  + 'Always use query_schedule for factual questions -- it computes exact filters, sorts, and '
  + 'counts; do not try to eyeball or count matches yourself. '
  + 'To propose a change, call reassign_station or swap_people -- you never apply changes '
  + 'yourself, a human confirms them separately. Keep replies brief.';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function handleGetSchedule(eventId, env) {
  return json(await getSchedule(env, eventId));
}

async function handleAuth(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await isRateLimited(env, ip)) return json({ error: 'Too many attempts' }, 429);

  const { passphrase } = await request.json();
  if (passphrase !== env.ADMIN_PASSPHRASE) {
    await recordFailedAuth(env, ip);
    return json({ error: 'Invalid passphrase' }, 401);
  }
  await clearFailedAuth(env, ip);
  return json({ token: await issueToken(env) });
}

async function handleChat(request, env) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);

  const { messages, eventId } = await request.json();
  if (!Array.isArray(messages) || !messages.length) return json({ error: 'Missing messages' }, 400);

  // Force role to user/assistant only -- a client can't smuggle in its own
  // "system" message to override SYSTEM_PROMPT.
  const history = messages
    .filter((m) => typeof m?.content === 'string' && m.content)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const schedule = await getSchedule(env, eventId);

  const completion = await callAzureOpenAI(env, [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
  ]);

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    return json({ message: completion.choices[0]?.message?.content || "I didn't understand that." });
  }

  const args = JSON.parse(toolCall.function.arguments || '{}');
  const { name } = toolCall.function;

  if (name === 'query_schedule') {
    let rows = findRows(schedule, args);
    if (args.sort_by) rows = sortRows(rows, args.sort_by, args.order);

    if (args.count_only) {
      return json({ message: `${rows.length} matching row${rows.length === 1 ? '' : 's'}.` });
    }

    if (args.limit) rows = rows.slice(0, args.limit);
    if (!rows.length) return json({ message: 'No matching schedule rows found.' });

    return json({
      message: `Found ${rows.length} match${rows.length > 1 ? 'es' : ''}.`,
      table: {
        headers: ['Name', 'Day', 'Station', 'Time'],
        rows: rows.map((r) => [r.staff_name, r.day, r.station, `${r.start_time}–${r.end_time}`]),
      },
    });
  }

  if (name === 'reassign_station') {
    const plan = planReassign(schedule, args);
    if (!plan) return json({ message: `Couldn't find ${args.staff_name} on ${args.day}.` });
    return json({
      message: `Proposed: move ${args.staff_name} to ${args.new_station} on ${args.day}. Confirm to apply.`,
      table: plan.table,
      pendingAction: { type: 'reassign_station', args },
    });
  }

  if (name === 'swap_people') {
    const plan = planSwap(schedule, args);
    if (!plan) return json({ message: 'Could not find one or both people on that day.' });
    return json({
      message: `Proposed: swap ${args.staff_name_a} and ${args.staff_name_b} on ${args.day}. Confirm to apply.`,
      table: plan.table,
      pendingAction: { type: 'swap_people', args },
    });
  }

  return json({ message: 'Unsupported action.' });
}

async function handleConfirm(request, env) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);

  const { eventId, pendingAction } = await request.json();
  const schedule = await getSchedule(env, eventId);

  let updates = 0;
  if (pendingAction?.type === 'reassign_station') {
    updates = applyReassign(schedule, pendingAction.args);
  } else if (pendingAction?.type === 'swap_people') {
    updates = applySwap(schedule, pendingAction.args);
  } else {
    return json({ error: 'Unknown or missing action' }, 400);
  }

  if (!updates) return json({ error: 'Those rows no longer match -- schedule may have changed since this was proposed.' }, 409);

  await putSchedule(env, eventId, schedule);
  return json({ message: `Applied -- ${updates} row(s) updated.`, updates });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/schedule/') && request.method === 'GET') {
      return handleGetSchedule(url.pathname.split('/').pop(), env);
    }
    if (url.pathname === '/api/admin/auth' && request.method === 'POST') {
      return handleAuth(request, env);
    }
    if (url.pathname === '/api/admin/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }
    if (url.pathname === '/api/admin/confirm' && request.method === 'POST') {
      return handleConfirm(request, env);
    }
    return new Response('Not found', { status: 404 });
  },
};
