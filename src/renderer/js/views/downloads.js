// Download list views (All / Downloading / Queued / Paused / Completed / Failed / Video).
import { h, icon, clear } from '../dom.js';
import { formatBytes, formatDate, formatEta, formatSpeed, percent } from '../format.js';
import { confirmDialog, guard, openModal, toast } from '../ui.js';

export const LIST_VIEWS = {
  all: { title: 'All Downloads', sub: 'Every download BARQ knows about.', emptyIcon: 'download', emptyTitle: 'No downloads yet', emptyText: 'Add a link to start your first download. Everything you download is listed here with its full history.' },
  downloading: { title: 'Downloading', sub: 'Transfers in progress right now.', emptyIcon: 'bolt', emptyTitle: 'Nothing is downloading', emptyText: 'Active transfers will appear here with live speed and time remaining.' },
  queued: { title: 'Queued', sub: 'Waiting for a free slot or a scheduled time.', emptyIcon: 'queue', emptyTitle: 'The queue is empty', emptyText: 'Downloads waiting for a free connection slot or a scheduled start time appear here.' },
  paused: { title: 'Paused', sub: 'Partial data is kept so you can resume later.', emptyIcon: 'pause', emptyTitle: 'No paused downloads', emptyText: 'Paused downloads keep their partial data and appear here until resumed.' },
  completed: { title: 'Completed', sub: 'Finished and verified downloads.', emptyIcon: 'check', emptyTitle: 'No completed downloads', emptyText: 'Finished downloads are listed here so you can open them or their folder.' },
  failed: { title: 'Failed', sub: 'Downloads that stopped with an error or were canceled.', emptyIcon: 'alert', emptyTitle: 'No failures', emptyText: 'If a download fails, it appears here with a clear explanation and a retry option.' },
  video: { title: 'Video Downloads', sub: 'Media downloads handled by the optional video engine.', emptyIcon: 'video', emptyTitle: 'No video downloads', emptyText: 'The optional yt-dlp video engine arrives in Milestone 5. Video tasks will be listed here.' },
};

const CATEGORY_ICON = { video: 'video', audio: 'audio', document: 'document', archive: 'archive', program: 'program', image: 'image', other: 'file' };
const STATUS_DOT = { completed: 'dot-ok', downloading: 'dot-info', queued: '', scheduled: '', paused: 'dot-warn', failed: 'dot-error', canceled: 'dot-error' };
const ENGINE_NOTE = 'Available when the download engine ships (Milestone 2).';

function progressCell(row) {
  const pct = percent(row.downloaded_bytes, row.total_bytes);
  const bar = h('div', { class: `progress${pct === null && row.status === 'downloading' ? ' indeterminate' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, ...(pct !== null ? { 'aria-valuenow': Math.round(pct) } : {}) }, h('span'));
  if (pct !== null) bar.firstChild.style.width = `${pct}%`; // CSSOM is CSP-safe
  return h('div', { class: 'progress-cell' }, bar, h('small', { text: pct === null ? '—' : `${pct.toFixed(0)}%` }));
}

export function renderList(root, ctx, viewId) {
  const cfg = LIST_VIEWS[viewId];
  let rows = [];
  let selectedId = null;
  let category = 'all';
  let disposed = false;

  const localSearch = h('input', { class: 'input', type: 'search', placeholder: 'Filter this view', 'aria-label': 'Filter this view', maxlength: 200, value: ctx.state.search });
  const catSelect = h('select', { class: 'select', 'aria-label': 'Filter by category' },
    h('option', { value: 'all' }, 'All categories'),
    ...ctx.state.info.categories.map((c) => h('option', { value: c }, c[0].toUpperCase() + c.slice(1))));

  const btn = (label, ic, onclick, opts = {}) => h('button', { class: `btn btn-sm ${opts.cls || ''}`, type: 'button', onclick, disabled: opts.disabled, title: opts.title || label }, icon(ic), label);

  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Download actions' });
  const tableHost = h('div', { class: 'card table-wrap' });

  root.append(
    h('div', { class: 'view-header' },
      h('div', {}, h('h1', { text: cfg.title }), h('p', { class: 'view-sub', text: cfg.sub })),
      h('div', { class: 'toolbar' },
        h('label', { class: 'search-inline' }, icon('search'), localSearch),
        catSelect,
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.openAddDownload() }, icon('plus'), 'Add Download'))),
    toolbar,
    h('div', { class: 'toolbar-gap' }),
    tableHost,
  );

  function selected() { return rows.find((r) => r.id === selectedId) || null; }

  function renderToolbar() {
    clear(toolbar);
    const r = selected();
    const none = !r;
    toolbar.append(
      btn('Pause', 'pause', null, { disabled: true, title: ENGINE_NOTE }),
      btn('Resume', 'play', null, { disabled: true, title: ENGINE_NOTE }),
      btn('Cancel', 'x', null, { disabled: true, title: ENGINE_NOTE }),
      btn('Retry', 'retry', null, { disabled: true, title: ENGINE_NOTE }),
      h('span', { class: 'toolbar-sep', 'aria-hidden': 'true' }),
      btn('Open folder', 'folder', () => guard(ctx.api.downloads.showInFolder(r.id)), { disabled: none }),
      btn('Copy URL', 'link', () => guard(ctx.api.downloads.copyUrl(r.id), 'URL copied to clipboard'), { disabled: none }),
      btn('Error details', 'alert', () => showError(r), { disabled: none || !(r.error_code || r.error_message) }),
      btn('Remove', 'trash', () => removeSelected(), { disabled: none || r.status === 'downloading', cls: 'btn-danger' }),
    );
  }

  async function removeSelected() {
    const r = selected();
    if (!r) return;
    const ok = await confirmDialog({
      title: 'Remove from list?',
      message: `"${r.filename}" will be removed from BARQ's history. Files on disk are not deleted.`,
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    if (await guard(ctx.api.downloads.remove(r.id), 'Removed from list')) {
      selectedId = null;
      await refresh();
      ctx.refreshStats();
    }
  }

  function showError(r) {
    openModal((close) => ({
      title: 'Error details',
      body: [
        h('p', { text: r.filename }),
        h('pre', { class: 'error-details', text: `Code: ${r.error_code || '—'}\n\n${r.error_message || 'No message recorded.'}` }),
      ],
      actions: [h('button', { class: 'btn btn-primary', type: 'button', onclick: () => close() }, 'Close')],
    }));
  }

  function renderTable() {
    clear(tableHost);
    const visible = category === 'all' ? rows : rows.filter((r) => r.category === category);
    if (visible.length === 0) {
      const filtered = rows.length > 0 || ctx.state.search;
      tableHost.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-art' }, icon(filtered ? 'info' : cfg.emptyIcon)),
        h('h2', { text: filtered ? 'No matches' : cfg.emptyTitle }),
        h('p', { text: filtered ? 'No downloads match the current search or category filter.' : cfg.emptyText }),
        !filtered && viewId === 'all' ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.openAddDownload() }, icon('plus'), 'Add Download') : null));
      return;
    }
    const head = ['Filename', 'Category', 'Status', 'Progress', 'Downloaded', 'Total', 'Speed', 'Remaining', 'Destination', 'Date'];
    const optional = new Set(['Category', 'Destination', 'Remaining']);
    const tbody = h('tbody');
    for (const r of visible) {
      const live = ctx.liveStats.get(r.id); // engine telemetry (Milestone 2); absent ⇒ "—"
      const tr = h('tr', { tabindex: 0, 'aria-selected': r.id === selectedId ? 'true' : 'false', dataset: { id: r.id } },
        h('td', {}, h('div', { class: 'col-name', title: r.filename }, h('span', { class: 'file-icon' }, icon(CATEGORY_ICON[r.category] || 'file')), h('span', { text: r.filename }))),
        h('td', { class: 'col-optional' }, h('span', { class: 'cat-chip', text: r.category })),
        h('td', {}, h('span', { class: 'status-pill' }, h('span', { class: `dot ${STATUS_DOT[r.status] || ''}` }), r.status)),
        h('td', {}, progressCell(r)),
        h('td', { class: 'num', text: formatBytes(r.downloaded_bytes) }),
        h('td', { class: 'num', text: r.total_bytes == null ? 'Unknown' : formatBytes(r.total_bytes) }),
        h('td', { class: 'num', text: live ? formatSpeed(live.speedBps) : '—' }),
        h('td', { class: 'num col-optional', text: live ? formatEta(live.etaSeconds) : '—' }),
        h('td', { class: 'col-optional', title: r.destination_path, text: r.destination_path }),
        h('td', { text: formatDate(r.completed_at || r.created_at) }),
      );
      tbody.append(tr);
    }
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) select(Number(tr.dataset.id), false);
    });
    tbody.addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const sib = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
        if (sib) { sib.focus(); select(Number(sib.dataset.id), true); }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(Number(tr.dataset.id), true);
      } else if (e.key === 'Delete') {
        select(Number(tr.dataset.id), true);
        removeSelected();
      }
    });
    tableHost.append(h('table', { class: 'dl', 'aria-label': cfg.title },
      h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col', class: `${optional.has(t) ? 'col-optional' : ''} ${['Downloaded', 'Total', 'Speed', 'Remaining'].includes(t) ? 'num' : ''}`.trim() || null, text: t })))),
      tbody));
  }

  function select(id, keepFocus) {
    selectedId = id;
    for (const tr of tableHost.querySelectorAll('tr[data-id]')) tr.setAttribute('aria-selected', Number(tr.dataset.id) === id ? 'true' : 'false');
    renderToolbar();
    if (!keepFocus) { /* mouse selection keeps natural focus */ }
  }

  async function refresh() {
    try {
      rows = await ctx.api.downloads.list(viewId, ctx.state.search);
    } catch (err) {
      toast(err.message, 'error');
      rows = [];
    }
    if (disposed) return;
    if (selectedId && !rows.some((r) => r.id === selectedId)) selectedId = null;
    renderToolbar();
    renderTable();
  }

  localSearch.addEventListener('input', () => ctx.setSearch(localSearch.value));
  catSelect.addEventListener('change', () => { category = catSelect.value; renderTable(); });

  refresh();
  return {
    refresh,
    onSearch(value) { if (localSearch.value !== value) localSearch.value = value; refresh(); },
    dispose() { disposed = true; },
  };
}
