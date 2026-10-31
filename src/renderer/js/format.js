// Formatting helpers. Pure functions.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${UNITS[i]}`;
}

export function formatSpeed(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '0 B/s';
  return `${formatBytes(Math.round(bps))}/s`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const hh = Math.floor(m / 60);
  if (hh < 48) return `${hh}h ${m % 60}m`;
  return `${Math.floor(hh / 24)}d ${hh % 24}h`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export function formatDate(ms) {
  if (!Number.isFinite(ms)) return '—';
  return dateFmt.format(new Date(ms));
}

export function relativeTime(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const d = Math.round((now - ms) / 1000);
  if (d < 10) return 'just now';
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return formatDate(ms);
}

export function percent(done, total) {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(done)) return null;
  return Math.max(0, Math.min(100, (done / total) * 100));
}
