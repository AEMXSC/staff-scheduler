import {
  issueToken, requireAuth, isRateLimited, recordFailedAuth, clearFailedAuth,
} from './auth.js';
import { callAzureOpenAI, buildTools } from './openai.js';
import {
  getSchedule, distinctDays, isReadOnlySelect, runReadOnly,
  planReassign, planSwap, applyPending,
  planAddShift, planCancelShift, planEditShiftTime, coverageBySlot,
  replaceSchedule, getContacts, replaceContacts, getDirectory,
  planCoverShift, createRequest, listPendingRequests, getRequestById, markRequest,
  listRequestsForTarget, respondToRequest, listRecentChanges, isKnownStaff, listMyRequests,
  savePushSubscription, listPushSubscriptions, listStaffSubscriptions, deletePushSubscription,
  getContactEmail,
} from './db.js';
import { sendPush } from './push.js';
import { buildICS } from './ics.js';
import { slackDmByEmail } from './slack.js';

const EVENT_ID = 'ibc-2026';

// Hybrid, size-independent reasoning:
//  - run_sql does all arithmetic in the DB (exact at any scale)
//  - the model may call it several times per turn (query -> read -> query -> answer)
//  - a fixed-size digest gives it the shape of the data regardless of event size
//  - for small events only, the full schedule is also dropped in for qualitative
//    reasoning; above the threshold that auto-disables and it leans on SQL alone.
const MAX_STEPS = 4;
const FULL_DUMP_THRESHOLD = 300;
const TOOL_ROWS_CAP = 100; // rows fed back into context per query (count is always exact)

function scheduleDigest(schedule) {
  const people = new Set(schedule.map((r) => r.staff_name));
  const stations = [...new Set(schedule.map((r) => r.station))].filter(Boolean);
  const days = [...new Set(schedule.map((r) => r.day))];
  const times = schedule.flatMap((r) => [r.start_time, r.end_time]).filter(Boolean).sort();
  return `Rows: ${schedule.length}. Distinct people: ${people.size}. Days: ${days.join(', ')}. `
    + `Stations (${stations.length}): ${stations.join(', ')}. `
    + `Earliest ${times[0] || '?'}, latest ${times[times.length - 1] || '?'}.`;
}

function fullDumpText(schedule) {
  return schedule
    .map((r) => `${r.staff_name} | ${r.day} | ${r.start_time}-${r.end_time} | ${r.station}${r.is_floater ? ' | floater' : ''}`)
    .join('\n');
}

function systemPrompt(eventId, days, digest, fullDump) {
  let p = 'You are the scheduling assistant for a staff event. Answer questions and propose changes concisely.\n\n'
    + 'You have run_sql: compose ONE read-only SQLite SELECT per call, and you MAY call it multiple times in a turn '
    + '-- query, read the result, query again if needed, then give your answer. '
    + 'Do ALL filtering/counting/sorting/grouping/overlap logic in SQL -- never count, rank, or do arithmetic yourself.\n'
    + 'For judgment questions (is it balanced? who is overworked? any awkward gaps?), first run an aggregating query '
    + '(GROUP BY, counts, durations) and reason over that small result set -- not over raw rows.\n\n'
    + 'Table: shifts(id, event_id, staff_name, day, date, start_time, end_time, station, is_floater, group_name)\n'
    + `- ALWAYS include: WHERE event_id = '${eventId}'\n`
    + `- day is one of: ${days.join(', ')}\n`
    + '- start_time/end_time are \'HH:MM\' 24h strings and compare correctly as text\n'
    + '- is_floater: 1 = backup/floater, 0 = primary\n'
    + '- station is the demo/role (e.g. "Premiere Pro", "Info Counter"); use LIKE for partial matches\n'
    + '- the primary key is the id column -- use it (NOT rowid, which is unavailable) for self-joins or de-duping\n'
    + '- when the question is about PEOPLE (who / which people / how many people|staff|floaters), use DISTINCT '
    + 'staff_name -- e.g. COUNT(DISTINCT staff_name) -- so each person counts once; only COUNT(*) rows when the '
    + 'question is explicitly about shifts\n'
    + '- shift duration in minutes is EXACTLY: '
    + '(CAST(substr(end_time,1,2) AS INTEGER)*60 + CAST(substr(end_time,4,2) AS INTEGER)) '
    + '- (CAST(substr(start_time,1,2) AS INTEGER)*60 + CAST(substr(start_time,4,2) AS INTEGER)) '
    + '-- use this expression for any duration/length/longer-than question\n\n'
    + 'There is also a directory table for REACHING staff (query it with run_sql too):\n'
    + 'contacts(id, event_id, name, email, phone, slack, whatsapp, title, manager)\n'
    + `- filter WHERE event_id = '${eventId}'; join to shifts on contacts.name = shifts.staff_name\n`
    + '- use it for any "phone/email/slack/title/role/manager/how do I reach <person, or the person on <station> '
    + 'that day>" question; title is their badge title, manager is their manager\'s name (look that manager up in '
    + 'contacts for their email); a person may be in contacts but have some fields blank\n\n'
    + `Current time is ${new Date().toISOString()} (UTC). The event runs Fri 2026-09-11 to Mon 2026-09-14 in `
    + 'Amsterdam (CEST = UTC+2); day column holds the weekday name and times are local HH:MM. For "who is on '
    + 'now/next", map the current Amsterdam date to that weekday and compare local times; if today is outside '
    + 'the event window, say so rather than guessing.\n\n'
    + `Dataset digest: ${digest}\n\n`
    + 'To change the schedule use the write tools -- reassign_station, swap_people, add_shift, cancel_shift, '
    + 'edit_shift_time -- you never write directly, a human confirms each proposal. When a person has several '
    + 'shifts that day, pass station and/or start_time so the right one is targeted. '
    + 'Changing HOURS/TIMES -> edit_shift_time; changing the STATION/role -> reassign_station.\n'
    + 'For "which hours/slots are thinnest or busiest on the floor", call coverage_by_slot(day) and reason over '
    + 'the per-slot headcounts it returns.\n'
    + 'In your final answer, state counts/numbers verbatim from the query result (row_count is exact even when rows are truncated); '
    + 'for long lists, point to the table shown rather than retyping every name. Keep replies to 1-3 sentences.';
  if (fullDump) {
    p += '\n\nFull schedule below (small event -- provided for qualitative reasoning only; still use run_sql for any exact fact):\n'
      + fullDump;
  }
  return p;
}

const INLINE_LIMIT = 5;
const MAX_TABLE_ROWS = 30;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function handleGetSchedule(eventId, env) {
  return json(await getSchedule(env, eventId));
}

// Public staff directory (title/email/phone/slack) -- exposed by request so
// staff can tap to Slack/call at the booth.
async function handleGetDirectory(eventId, env) {
  return json(await getDirectory(env, eventId));
}

// Public per-person calendar feed (.ics). Serves the "add to calendar" download
// and the webcal subscription -- same body, `?download=1` just sets the
// attachment header. Public, like the schedule/directory endpoints.
async function handleCalendar(url, env) {
  const eventId = url.pathname.split('/').pop().replace(/\.ics$/i, '');
  const name = (url.searchParams.get('name') || '').trim();
  if (!/^[a-z0-9-]{1,64}$/i.test(eventId)) return new Response('Bad event', { status: 400 });
  if (!name || name.length > 100) return new Response('Bad name', { status: 400 });

  let meta = { name: 'IBC 2026', timezone: 'Europe/Amsterdam' };
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(`/events/${eventId}.json`, url)));
    if (res.ok) meta = await res.json();
  } catch { /* fall back to defaults */ }

  const schedule = await getSchedule(env, eventId);
  const shifts = schedule
    .filter((r) => r.staff_name && r.staff_name.toLowerCase() === name.toLowerCase())
    .sort((a, b) => `${a.date} ${a.start_time}`.localeCompare(`${b.date} ${b.start_time}`));

  const ics = buildICS({
    eventId, eventName: meta.name, personName: name, tz: meta.timezone || 'Europe/Amsterdam', shifts,
  });
  const headers = {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Cache-Control': 'no-cache',
  };
  if (url.searchParams.get('download') === '1') {
    const file = `ibc-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schedule'}.ics`;
    headers['Content-Disposition'] = `attachment; filename="${file}"`;
  }
  return new Response(ics, { headers });
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

const WRITE_TOOLS = new Set([
  'reassign_station', 'swap_people', 'add_shift', 'cancel_shift', 'edit_shift_time',
]);

// A proposed write is terminal for the turn: build the diff, hand it to the
// frontend's Confirm/Cancel, never touch the loop.
async function proposeWrite(env, eventId, name, args) {
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
  if (name === 'add_shift') {
    const plan = await planAddShift(env, eventId, args);
    if (plan.badTime) return json({ message: 'Times must be 24-hour HH:MM (e.g. 14:30).' });
    return json({
      message: `Proposed: add ${args.staff_name} to ${args.station} on ${args.day} ${args.start_time}–${args.end_time}. Confirm to apply.`,
      table: plan.table,
      pendingAction: plan.pending,
    });
  }
  if (name === 'cancel_shift') {
    const plan = await planCancelShift(env, eventId, args);
    if (plan.error) return json({ message: `Couldn't find a shift for ${args.staff_name} on ${args.day}.` });
    if (plan.ambiguous) return json({ message: `"${args.staff_name}" matches multiple people (${plan.ambiguous.join(', ')}) — use a full name.` });
    if (plan.manyShifts) return json({ message: `${args.staff_name} has several shifts on ${args.day} (${plan.manyShifts.join('; ')}) — say which station or start time to cancel.` });
    return json({
      message: `Proposed: remove ${args.staff_name}'s ${args.day} shift. Confirm to apply.`,
      table: plan.table,
      pendingAction: plan.pending,
    });
  }
  if (name === 'edit_shift_time') {
    const plan = await planEditShiftTime(env, eventId, args);
    if (plan.badTime) return json({ message: 'New times must be 24-hour HH:MM (e.g. 14:30).' });
    if (plan.error) return json({ message: `Couldn't find a shift for ${args.staff_name} on ${args.day}.` });
    if (plan.ambiguous) return json({ message: `"${args.staff_name}" matches multiple people (${plan.ambiguous.join(', ')}) — use a full name.` });
    if (plan.manyShifts) return json({ message: `${args.staff_name} has several shifts on ${args.day} (${plan.manyShifts.join('; ')}) — say which one to change.` });
    return json({
      message: `Proposed: change ${args.staff_name}'s ${args.day} shift to ${args.new_start_time}–${args.new_end_time}. Confirm to apply.`,
      table: plan.table,
      pendingAction: plan.pending,
    });
  }
  const plan = await planSwap(env, eventId, args);
  if (plan.error) return json({ message: 'Could not find one or both people on that day.' });
  if (plan.ambiguous) return json({ message: `That name matches multiple people (${plan.ambiguous.join(', ')}) — use a full name.` });
  return json({
    message: `Proposed: swap ${args.staff_name_a} and ${args.staff_name_b} on ${args.day}. Confirm to apply.`,
    table: plan.table,
    pendingAction: plan.pending,
  });
}

// Render a final answer: the model's prose plus, if the turn ran any query,
// the last result set as a table.
function finalAnswer(message, lastRows) {
  if (!lastRows || !lastRows.length) return json({ message });
  const headers = Object.keys(lastRows[0]);
  return json({
    message,
    table: { headers, rows: lastRows.slice(0, MAX_TABLE_ROWS).map((r) => headers.map((h) => `${r[h]}`)) },
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
  const fullDump = schedule.length < FULL_DUMP_THRESHOLD ? fullDumpText(schedule) : null;
  const tools = buildTools(days);

  const convo = [
    { role: 'system', content: systemPrompt(eventId, days, scheduleDigest(schedule), fullDump) },
    ...history,
  ];

  let lastRows = null;

  // Agentic loop: let the model query, read the result, and query again before
  // answering. Reads go through the same read-only guard; writes short-circuit.
  for (let step = 0; step < MAX_STEPS; step++) {
    const completion = await callAzureOpenAI(env, convo, tools);
    const aiMsg = completion.choices[0]?.message;
    const toolCalls = aiMsg?.tool_calls || [];

    if (!toolCalls.length) {
      return finalAnswer(aiMsg?.content || "I didn't understand that.", lastRows);
    }

    const write = toolCalls.find((t) => WRITE_TOOLS.has(t.function.name));
    if (write) {
      let wargs;
      try { wargs = JSON.parse(write.function.arguments || '{}'); } catch { return json({ message: 'I mis-formed that change — please rephrase it.' }); }
      return proposeWrite(env, eventId, write.function.name, wargs);
    }

    // Run every read call and feed each result back keyed by tool_call_id.
    convo.push(aiMsg);
    for (const tc of toolCalls) {
      let content;
      const a = JSON.parse(tc.function.arguments || '{}');
      try {
        if (tc.function.name === 'run_sql') {
          if (!isReadOnlySelect(a.sql || '')) {
            content = 'BLOCKED: only read-only SELECT queries are allowed.';
          } else {
            lastRows = await runReadOnly(env, a.sql);
            content = JSON.stringify({ row_count: lastRows.length, rows: lastRows.slice(0, TOOL_ROWS_CAP) });
          }
        } else if (tc.function.name === 'coverage_by_slot') {
          lastRows = await coverageBySlot(env, eventId, a.day);
          content = JSON.stringify({ row_count: lastRows.length, rows: lastRows.slice(0, TOOL_ROWS_CAP) });
        } else {
          content = `ERROR: unknown tool ${tc.function.name}`;
        }
      } catch (e) {
        content = `ERROR: ${e.message}`;
      }
      convo.push({ role: 'tool', tool_call_id: tc.id, content });
    }
  }

  // Ran out of steps still wanting to query -- return the last result set.
  if (lastRows) return resultResponse(lastRows);
  return json({ message: 'I could not resolve that in a few steps — try narrowing the question.' });
}

async function handleConfirm(request, env) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { pendingAction } = await request.json();
  if (!pendingAction?.type) return json({ error: 'Missing action' }, 400);

  const result = await applyPending(env, pendingAction);
  if (result.drift) return json({ error: 'Those rows changed since this was proposed — re-run the request.' }, 409);
  if (result.duplicate) return json({ error: 'That shift already exists — nothing was added.' }, 409);
  if (result.error) return json({ error: 'Unknown action' }, 400);
  return json({ message: `Applied — ${result.updates} row(s) updated.`, updates: result.updates });
}

async function handleScheduleUpload(request, env) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { eventId, rows } = await request.json();
  const result = await replaceSchedule(env, eventId || EVENT_ID, rows);
  if (result.error) return json({ error: result.error }, 400);
  return json({ message: `Schedule replaced — ${result.inserted} shifts loaded.`, inserted: result.inserted });
}

async function handleContactsUpload(request, env) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { eventId, rows } = await request.json();
  const result = await replaceContacts(env, eventId || EVENT_ID, rows);
  if (result.error) return json({ error: result.error }, 400);
  return json({ message: `Directory replaced — ${result.inserted} contacts loaded.`, inserted: result.inserted });
}

// Behind auth: contact rows include PII (phone/email).
async function handleGetContacts(request, env) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);
  const eventId = new URL(request.url).searchParams.get('eventId') || EVENT_ID;
  return json(await getContacts(env, eventId));
}

// Best-effort push to any admin who enabled phone alerts. Never throws into
// the request flow; prunes dead subscriptions.
async function pushAll(env, subs) {
  await Promise.all(subs.map(async (s) => {
    try {
      const r = await sendPush(env, s);
      if (r.status === 404 || r.status === 410) await deletePushSubscription(env, s.endpoint);
    } catch { /* push is best-effort */ }
  }));
}

async function notifyAdmins(env) {
  await pushAll(env, await listPushSubscriptions(env));
}

// Targeted push to the person who was asked to cover (their device shows a
// "you were asked" alert; see the service worker).
async function notifyStaff(env, name) {
  if (!name) return;
  await pushAll(env, await listStaffSubscriptions(env, name));
}

// Reach a person on every available channel: app push (if they enabled it) and
// a Slack DM (if a bot token is configured and we can resolve their email).
async function pingPerson(env, eventId, name, text) {
  if (!name) return;
  await notifyStaff(env, name);
  if (env.SLACK_BOT_TOKEN) {
    const email = await getContactEmail(env, eventId, name);
    if (email) await slackDmByEmail(env, email, text);
  }
}

async function handlePushKey(env) {
  return json({ key: env.VAPID_PUBLIC || '' });
}

// Only accept subscription endpoints on known push services over https -- so a
// stored endpoint can't turn notifyAdmins into an arbitrary-URL fetch proxy.
const ALLOWED_PUSH_HOSTS = [/\.googleapis\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/, /\.mozilla\.com$/];
function isAllowedPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && ALLOWED_PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

async function handlePushSubscribe(request, env) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);
  const sub = await request.json();
  if (!sub || !isAllowedPushEndpoint(sub.endpoint)) return json({ error: 'Invalid push endpoint.' }, 400);
  const result = await savePushSubscription(env, sub);
  if (result.error) return json({ error: result.error }, 400);
  return json({ ok: true });
}

// Public: a staff member subscribes their own device, keyed to their name, so a
// directed ask can push straight to them. Rate-limited + endpoint-allowlisted.
async function handlePushSubscribeStaff(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  // Own bucket so push opt-in doesn't share the shift-request quota (shared
  // booth Wi-Fi would otherwise let alert-clicks lock out submissions).
  const key = `pushrate:${ip}`;
  const raw = await env.SCHEDULE_KV.get(key);
  if (raw !== null && Number(raw) >= REQ_RATE_MAX) return json({ error: 'Too many requests — try again later.' }, 429);
  await env.SCHEDULE_KV.put(key, String((raw ? Number(raw) : 0) + 1), { expirationTtl: REQ_RATE_TTL });

  const { subscription, name } = await request.json();
  if (!name || !`${name}`.trim()) return json({ error: 'Pick your name first.' }, 400);
  if (!subscription || !isAllowedPushEndpoint(subscription.endpoint)) return json({ error: 'Invalid push endpoint.' }, 400);
  const result = await savePushSubscription(env, subscription, name);
  if (result.error) return json({ error: result.error }, 400);
  return json({ ok: true });
}

// Public (staff aren't logged in): submit a change request for your own shift.
// Rate-limited per IP; never mutates the schedule -- only queues a proposal.
const REQ_RATE_MAX = 15;
const REQ_RATE_TTL = 600;
async function handleCreateRequest(request, env, ctx) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `reqrate:${ip}`;
  const raw = await env.SCHEDULE_KV.get(key);
  if (raw !== null && Number(raw) >= REQ_RATE_MAX) return json({ error: 'Too many requests — try again later.' }, 429);
  await env.SCHEDULE_KV.put(key, String((raw ? Number(raw) : 0) + 1), { expirationTtl: REQ_RATE_TTL });

  const body = await request.json();
  const result = await createRequest(env, body.eventId || EVENT_ID, {
    requesterName: body.requesterName,
    shiftId: body.shiftId,
    targetName: body.targetName,
    message: body.message,
    requestedStart: body.requestedStart,
    requestedEnd: body.requestedEnd,
  });
  if (result.error) {
    const msg = {
      noname: 'Please select your name first.',
      noshift: 'That shift could not be found.',
      mismatch: 'You can only request changes to your own shift.',
      exists: 'There is already a pending change request for this shift.',
      badtarget: 'Pick a person from the list — that name isn\'t on staff.',
    }[result.error] || 'Could not submit the request.';
    return json({ error: msg }, 400);
  }
  // Only ping admins once a request actually reaches their queue (open asks
  // immediately; directed asks only after the target accepts).
  if (ctx && result.status === 'awaiting_admin') ctx.waitUntil(notifyAdmins(env));
  // Directed ask -> reach the person who was asked (push + Slack DM).
  if (ctx && result.status === 'awaiting_target') {
    ctx.waitUntil((async () => {
      const rq = await getRequestById(env, result.id);
      if (rq) {
        await pingPerson(env, rq.event_id, rq.target_name,
          `${rq.requester_name} asked you to cover ${rq.station} on ${rq.day} ${rq.start_time}-${rq.end_time}. Open the staff app to Accept or Decline.`);
      }
    })());
  }
  return json({ ok: true, id: result.id, status: result.status });
}

// Public: the asked person sees requests waiting for their accept/decline.
async function handleRequestsForTarget(request, env) {
  const url = new URL(request.url);
  const eventId = url.searchParams.get('eventId') || EVENT_ID;
  const name = url.searchParams.get('name') || '';
  if (!name.trim()) return json([]);
  return json(await listRequestsForTarget(env, eventId, name));
}

// Public: the asked person accepts (applies the cover now + notifies the admin)
// or declines.
async function handleRespondRequest(request, env, ctx) {
  // This is now a mutation path (accept applies) -> throttle per IP so directed
  // swaps can't be scripted/hijacked at scale.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `resprate:${ip}`;
  const rlRaw = await env.SCHEDULE_KV.get(rlKey);
  if (rlRaw !== null && Number(rlRaw) >= REQ_RATE_MAX) return json({ error: 'Too many attempts — try again later.' }, 429);
  await env.SCHEDULE_KV.put(rlKey, String((rlRaw ? Number(rlRaw) : 0) + 1), { expirationTtl: REQ_RATE_TTL });

  const { id, name, action } = await request.json();
  if (!id || !name || (action !== 'accept' && action !== 'decline')) return json({ error: 'Bad request' }, 400);
  const result = await respondToRequest(env, id, name, action);
  if (result.error === 'notfound') return json({ error: 'Request not found.' }, 404);
  if (result.error === 'notpending') return json({ error: 'That request was already handled.' }, 409);
  if (result.error === 'mismatch') return json({ error: 'That request was not addressed to you.' }, 403);
  if (result.error) return json({ error: 'Could not respond.' }, 400);
  if (action === 'decline') {
    // let the requester know so they can ask someone else
    if (ctx) {
      ctx.waitUntil(pingPerson(env, result.req.event_id, result.req.requester_name,
        `${result.req.target_name} declined your ${result.req.station} ${result.req.day} shift request — you can ask someone else.`));
    }
    return json({ message: 'Declined.' });
  }
  // accepted -> to the admin queue to confirm; buzz the admin (+ Slack if set)
  if (ctx) {
    ctx.waitUntil(notifyAdmins(env));
    if (env.SLACK_BOT_TOKEN && env.SLACK_ADMIN_EMAIL) {
      ctx.waitUntil(slackDmByEmail(env, env.SLACK_ADMIN_EMAIL,
        `${result.req.target_name} accepted ${result.req.requester_name}'s ${result.req.station} ${result.req.day} shift — approve it in the admin app.`));
    }
  }
  return json({ message: 'Accepted — sent to the admin to confirm.' });
}

async function handleRecentChanges(request, env) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);
  const eventId = new URL(request.url).searchParams.get('eventId') || EVENT_ID;
  return json(await listRecentChanges(env, eventId));
}

// Public: a requester's own outgoing requests + state (no other-person data).
async function handleMyRequests(request, env) {
  const url = new URL(request.url);
  const eventId = url.searchParams.get('eventId') || EVENT_ID;
  const name = url.searchParams.get('name') || '';
  if (!name.trim()) return json([]);
  return json(await listMyRequests(env, eventId, name));
}

async function handleListRequests(request, env) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);
  const eventId = new URL(request.url).searchParams.get('eventId') || EVENT_ID;
  return json(await listPendingRequests(env, eventId));
}

// Approve applies the change through the SAME drift-guarded apply path as the
// AI confirm flow (cover_shift), then records the outcome. Decline just marks it.
async function handleResolveRequest(request, env, ctx) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { id, action, covererName } = await request.json();
  if (!id || (action !== 'approve' && action !== 'decline')) return json({ error: 'Bad request' }, 400);
  const req = await getRequestById(env, id);
  if (!req) return json({ error: 'Request not found' }, 404);
  if (req.status !== 'awaiting_admin') return json({ error: 'That request is not ready for approval.' }, 409);

  if (action === 'decline') {
    await markRequest(env, id, 'declined', null);
    return json({ message: 'Request declined.' });
  }

  const coverer = (typeof covererName === 'string' && covererName.trim()) || req.target_name;
  if (!coverer) return json({ error: 'Choose who will cover before approving.' }, 400);
  if (!(await isKnownStaff(env, req.event_id, coverer))) return json({ error: 'That coverer is not on the staff list.' }, 400);
  const plan = await planCoverShift(env, req.event_id, {
    shift_id: req.shift_id,
    coverer_name: coverer,
    // Snapshot captured when the request was filed -- drift-guards against the
    // shift being reassigned/edited between request and approval.
    expect: {
      staff_name: req.requester_name,
      station: req.station,
      start_time: req.start_time,
      end_time: req.end_time,
    },
    // The sub-window to hand off; falls back to the full shift for legacy
    // requests filed before requested_start/end existed.
    window: { start: req.requested_start, end: req.requested_end },
  });
  if (plan.error === 'notfound') return json({ error: 'That shift no longer exists (the schedule may have been reloaded).' }, 409);
  if (plan.error) return json({ error: 'Could not build the change.' }, 400);
  const applied = await applyPending(env, plan.pending);
  if (applied.drift) return json({ error: 'That shift changed since the request was made — review and retry.' }, 409);
  if (applied.error) return json({ error: 'Could not apply the change.' }, 400);
  await markRequest(env, id, 'approved', coverer);
  // Notify both parties about the exact window that was handed off (not the
  // whole shift -- a partial cover only moves the covered slice).
  const cw = plan.pending.window;
  if (ctx) {
    ctx.waitUntil(pingPerson(env, req.event_id, req.requester_name,
      `Your ${req.station} ${req.day} ${cw.start}-${cw.end} shift is now covered by ${coverer}.`));
    ctx.waitUntil(pingPerson(env, req.event_id, coverer,
      `You're confirmed to cover ${req.station} on ${req.day} ${cw.start}-${cw.end}.`));
  }
  return json({ message: `Approved — ${coverer} now covers ${req.station} ${cw.start}-${cw.end}.`, coverer });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/schedule/') && request.method === 'GET') {
      return handleGetSchedule(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.startsWith('/api/directory/') && request.method === 'GET') {
      return handleGetDirectory(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.startsWith('/api/calendar/') && request.method === 'GET') {
      return handleCalendar(url, env);
    }
    if (url.pathname === '/api/admin/auth' && request.method === 'POST') return handleAuth(request, env);
    if (url.pathname === '/api/admin/chat' && request.method === 'POST') return handleChat(request, env);
    if (url.pathname === '/api/admin/confirm' && request.method === 'POST') return handleConfirm(request, env);
    if (url.pathname === '/api/admin/schedule-upload' && request.method === 'POST') return handleScheduleUpload(request, env);
    if (url.pathname === '/api/admin/contacts-upload' && request.method === 'POST') return handleContactsUpload(request, env);
    if (url.pathname === '/api/admin/contacts' && request.method === 'GET') return handleGetContacts(request, env);
    if (url.pathname === '/api/requests' && request.method === 'POST') return handleCreateRequest(request, env, ctx);
    if (url.pathname === '/api/requests/for' && request.method === 'GET') return handleRequestsForTarget(request, env);
    if (url.pathname === '/api/requests/respond' && request.method === 'POST') return handleRespondRequest(request, env, ctx);
    if (url.pathname === '/api/requests/mine' && request.method === 'GET') return handleMyRequests(request, env);
    if (url.pathname === '/api/admin/requests' && request.method === 'GET') return handleListRequests(request, env);
    if (url.pathname === '/api/admin/requests/recent' && request.method === 'GET') return handleRecentChanges(request, env);
    if (url.pathname === '/api/admin/requests/resolve' && request.method === 'POST') return handleResolveRequest(request, env, ctx);
    if (url.pathname === '/api/push/vapid-public' && request.method === 'GET') return handlePushKey(env);
    if (url.pathname === '/api/admin/push/subscribe' && request.method === 'POST') return handlePushSubscribe(request, env);
    if (url.pathname === '/api/push/subscribe/staff' && request.method === 'POST') return handlePushSubscribeStaff(request, env);
    return new Response('Not found', { status: 404 });
  },
};
