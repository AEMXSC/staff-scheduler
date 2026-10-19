// Per-event identity: which event to show, and how to skin the page for it.
// Keeps the app one codebase that serves multiple conferences (IBC, MAX, …) by
// subdomain + config, instead of a fork per event.

// Explicit ?event= wins (for testing/links); otherwise derive from the
// subdomain (max.* -> max-2026, ibc.* -> ibc-2026); default to IBC.
export function resolveEventId() {
  const q = new URLSearchParams(window.location.search).get('event');
  if (q) return q;
  const sub = window.location.hostname.split('.')[0];
  if (sub === 'max') return 'max-2026';
  if (sub === 'ibc') return 'ibc-2026';
  return 'ibc-2026';
}

// Apply an event's theme + identity: accent CSS tokens, document title, and the
// browser theme-color. Absent fields fall back to the current IBC look, so older
// event configs keep rendering unchanged.
export function applyTheme(event) {
  const t = (event && event.theme) || {};
  const root = document.documentElement;
  if (t.accent) root.style.setProperty('--accent', t.accent);
  if (t.accentInk) root.style.setProperty('--accent-ink', t.accentInk);
  if (t.floater) root.style.setProperty('--floater', t.floater);

  const title = (event && event.branding && event.branding.title)
    || (event && event.name ? `${event.name} Staff Schedule` : 'Staff Schedule');
  document.title = title;

  if (t.accent) {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.append(meta); }
    meta.content = t.accent;
  }
}

// The event logo + its alt text, with the IBC asset as the fallback.
export function eventLogo(event) {
  const b = (event && event.branding) || {};
  return { src: b.logo || '/images/ibc-logo-white.png', alt: b.shortName || event?.name || 'Event' };
}
