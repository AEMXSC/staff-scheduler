import {
  issueToken, requireAuth, isRateLimited, recordFailedAuth, clearFailedAuth,
} from './auth.js';
import { callAzureOpenAI, buildTools } from './openai.js';
import {
  getSchedule, distinctDays, isReadOnlySelect, runReadOnly,
  planReassign, planSwap, applyPending,
} from './db.js';

const EVENT_ID = 'ibc-2026';

function systemPrompt(days) {
  return 'You are the scheduling assistant for a staff event. Answer questions and propose changes concisely.\n\n'
    + 'For any factual or analytical question, call run_sql with ONE read-only SQLite SELECT. '
    + 'Do all filtering/counting/sorting/grouping in SQL -- never count or rank yourself.\n\n'
    + 'Table: shifts(id, event_id, staff_name, day, date, start_time, end_time, station, is_floater, group_name)\n'
    + `- ALWAYS include: WHERE event_id = '${EVENT_ID}'\n`
    + `- day is one of: ${days.join(', ')}\n`
    + '- start_time/end_time are \'HH:MM\' 24h strings and compare correctly as text\n'
    + '- is_floater: 1 = backup/floater, 0 = primary\n'
    + '- station is the demo/role (e.g. "Premiere Pro", "Info Counter"); use LIKE for partial matches\n\n'
    + 'To change the schedule, call reassign_station or swap_people -- you never write directly, a human confirms.\n'
    + 'Keep replies to 1-2 sentences; the data table is shown separately.';
}

const INLINE_LIMIT = 5;
const MAX_TABLE_ROWS = 30;

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

// Turn a result-set into a compact table + a short factual message. The
// message spells out small results so chat follow-ups have real facts to
// ground on, not a bare "Found N".
function resultResponse(rows) {
  if (!rows.length) return json({ message: 'No matching rows.' });
  const headers = Object.keys(rows[0]);
  const capped = rows.slice(0, MAX_TABLE_ROWS);
  let message;
  if (rows.length <= INLINE_LIMIT) {
    message = capped.map((r) => headers.map((h) => `${r[h]}`).join(' · ')).join('; ');
  } else {
    message = `${rows.length} result${rows.length === 1 ? '' : 's'}${rows.length > MAX_TABLE_ROWS ? ` (showing ${MAX_TABLE_ROWS})` : ''}.`;
  }
  return json({
    message,
    table: { headers, rows: capped.map((r) => headers.map((h) => `${r[h]}`)) },
  });
}

async function handleChat(request, env) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);

  const { messages, eventId } = await request.json();
  if (!Array.isArray(messages) || !messages.length) return json({ error: 'Missing messages' }, 400);
  const history = messages
    .filter((m) => typeof m?.content === 'string' && m.content)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const schedule = await getSchedule(env, eventId);
  const days = distinctDays(schedule);

  const completion = await callAzureOpenAI(env, [
    { role: 'system', content: systemPrompt(days) },
    ...history,
  ], buildTools(days));

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    return json({ message: completion.choices[0]?.message?.content || "I didn't understand that." });
  }

  const args = JSON.parse(toolCall.function.arguments || '{}');
  const { name } = toolCall.function;

  if (name === 'run_sql') {
    if (!isReadOnlySelect(args.sql || '')) {
      return json({ message: 'That query was blocked — only read-only SELECTs are allowed.' });
    }
    try {
      const rows = await runReadOnly(env, args.sql);
      return resultResponse(rows);
    } catch (e) {
      return json({ message: `Query error: ${e.message}` });
    }
  }

  if (name === 'reassign_station') {
    const plan = await planReassign(env, eventId, args);
    if (plan.error) return json({ message: `Couldn't find ${args.staff_name} on ${args.day}.` });
    if (plan.ambiguous) return json({ message: `"${args.staff_name}" matches multiple people (${plan.ambiguous.join(', ')}) — use a full name.` });
    return json({
      message: `Proposed: move ${args.staff_name} to ${args.new_station} on ${args.day}. Confirm to apply.`,
      table: plan.table,
      pendingAction: plan.pending,
    });
  }

  if (name === 'swap_people') {
    const plan = await planSwap(env, eventId, args);
    if (plan.error) return json({ message: 'Could not find one or both people on that day.' });
    if (plan.ambiguous) return json({ message: `That name matches multiple people (${plan.ambiguous.join(', ')}) — use a full name.` });
    return json({
      message: `Proposed: swap ${args.staff_name_a} and ${args.staff_name_b} on ${args.day}. Confirm to apply.`,
      table: plan.table,
      pendingAction: plan.pending,
    });
  }

  return json({ message: 'Unsupported action.' });
}

async function handleConfirm(request, env) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { pendingAction } = await request.json();
  if (!pendingAction?.type) return json({ error: 'Missing action' }, 400);

  const result = await applyPending(env, pendingAction);
  if (result.drift) return json({ error: 'Those rows changed since this was proposed — re-run the request.' }, 409);
  if (result.error) return json({ error: 'Unknown action' }, 400);
  return json({ message: `Applied — ${result.updates} row(s) updated.`, updates: result.updates });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/schedule/') && request.method === 'GET') {
      return handleGetSchedule(url.pathname.split('/').pop(), env);
    }
    if (url.pathname === '/api/admin/auth' && request.method === 'POST') return handleAuth(request, env);
    if (url.pathname === '/api/admin/chat' && request.method === 'POST') return handleChat(request, env);
    if (url.pathname === '/api/admin/confirm' && request.method === 'POST') return handleConfirm(request, env);
    return new Response('Not found', { status: 404 });
  },
};
