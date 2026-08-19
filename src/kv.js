export async function getSchedule(env, eventId) {
  const raw = await env.SCHEDULE_KV.get(`schedule:${eventId}`);
  return raw ? JSON.parse(raw) : [];
}

export async function putSchedule(env, eventId, rows) {
  await env.SCHEDULE_KV.put(`schedule:${eventId}`, JSON.stringify(rows));
}
