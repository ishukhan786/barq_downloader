// Dashboard view: Total, Active, Completed, Failed, Overall Speed, Queue preview, Recent Activity
import { h, icon, clear } from '../dom.js';
import { formatBytes, formatDate, formatSpeed, relativeTime } from '../format.js';

export function renderDashboard(root, ctx) {
  let disposed = false;

  const statCard = (label, id, ic, cls = '') =>
    h('div', { class: `card stat ${cls}` },
      h('div', { class: 'stat-label' }, icon(ic), label),
      h('div', { class: 'stat-value', id: `dash-${id}`, text: '—' }));

  const grid = h('div', { class: 'stats-grid' },
    statCard('Active Downloads', 'active', 'bolt', 'stat-accent'),
    statCard('Overall Speed', 'speed', 'download', 'stat-speed'),
    statCard('Queued', 'queued', 'queue'),
    statCard('Completed', 'completed', 'check'),
    statCard('Failed / Canceled', 'failed', 'alert', 'stat-danger'),
    statCard('Total Downloads', 'total', 'file'),
  );

  const hero = h('div', { class: 'card hero' },
    h('img', { src: 'assets/brand/barq-mark.svg', alt: '', width: 52, height: 52 }),
    h('div', {},
      h('div', { class: 'hero-title' },
        h('span', { class: 'wordmark', text: 'BARQ' }),
        h('span', { class: 'wordmark-urdu', lang: 'ur', dir: 'rtl', text: 'برق' })),
      h('span', { class: 'tagline', text: 'Speed at Every Click.' })),
    h('div', { class: 'hero-actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.openAddDownload() },
        icon('plus'), 'Add Download'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate('settings') },
        icon('bolt'), 'Settings')));

  const queueList = h('div', { class: 'card-pad' });
  const activityList = h('ul', { class: 'activity' });

  const dashContent = h('div', { class: 'dash-grid' },
    h('div', { class: 'card' },
      h('div', { class: 'card-header' },
        h('h2', { text: 'Download Queue' }),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => ctx.navigate('queued') }, 'View queue →')),
      queueList),
    h('div', { class: 'card' },
      h('div', { class: 'card-header' },
        h('h2', { text: 'Recent Activity' })),
      activityList));

  root.append(
    h('div', { class: 'view-header' },
      h('div', {},
        h('h1', { text: 'Dashboard' }),
        h('p', { class: 'view-sub', text: 'Live overview of your downloads and activity.' }))),
    hero,
    grid,
    dashContent,
  );

  async function refresh() {
    try {
      const [stats, queue, activity] = await Promise.all([
        ctx.api.stats.get(),
        ctx.api.downloads.queue(),
        ctx.api.activity.recent(),
      ]);

      if (disposed) return;

      const setVal = (id, val) => {
        const el = document.getElementById(`dash-${id}`);
        if (el) el.textContent = String(val);
      };

      setVal('active', stats.active);
      setVal('speed', formatSpeed(stats.overallSpeedBps));
      setVal('queued', stats.queued);
      setVal('completed', stats.completed);
      setVal('failed', stats.failed);
      setVal('total', stats.total);

      // Render Queue
      clear(queueList);
      if (queue.length === 0) {
        queueList.append(
          h('div', { class: 'empty' },
            h('p', { text: 'No active or queued downloads at this moment.' }))
        );
      } else {
        const qTable = h('table', { class: 'dl' },
          h('thead', {},
            h('tr', {},
              h('th', { text: 'File' }),
              h('th', { text: 'Status' }),
              h('th', { class: 'num', text: 'Downloaded' }))),
          h('tbody', {},
            ...queue.map((item) =>
              h('tr', {},
                h('td', { class: 'col-name', text: item.filename, title: item.filename }),
                h('td', { text: item.status }),
                h('td', { class: 'num', text: formatBytes(item.downloaded_bytes) })))));
        queueList.append(qTable);
      }

      // Render Activity
      clear(activityList);
      if (activity.length === 0) {
        activityList.append(
          h('li', {},
            h('span', { class: 'nav-count', text: 'No recent activity recorded.' }))
        );
      } else {
        for (const act of activity) {
          const dotCls = act.level === 'warn' ? 'dot-warn' : act.level === 'error' ? 'dot-error' : 'dot-info';
          activityList.append(
            h('li', {},
              h('span', { class: `dot ${dotCls}` }),
              h('span', { class: 'setting-text', text: act.message }),
              h('time', { text: relativeTime(act.created_at) }))
          );
        }
      }
    } catch (err) {
      if (!disposed) console.error('Dashboard refresh failed:', err);
    }
  }

  refresh();
  return {
    refresh,
    dispose() { disposed = true; },
  };
}
