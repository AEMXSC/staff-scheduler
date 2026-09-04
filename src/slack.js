// Slack bot DMs. No-op unless SLACK_BOT_TOKEN is set, so the app runs fine
// before the token is provisioned. Resolves a person by their email (LDAP)
// to a Slack user id, then direct-messages them. Best-effort (never throws).

export async function slackDmByEmail(env, email, text) {
  if (!env.SLACK_BOT_TOKEN || !email) return;
  try {
    const look = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.json());
    if (!look || !look.ok || !look.user) return;
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: look.user.id, text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* best-effort */ }
}
