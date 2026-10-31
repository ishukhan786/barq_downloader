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

    const canPause = r && (r.status === 'downloading' || r.status === 'queued');
    const canResume = r && (r.status === 'paused' || r.status === 'queued');
    const canCancel = r && ['downloading', 'queued', 'paused'].includes(r.status);
    const canRetry = r && ['failed', 'canceled', 'paused'].includes(r.status);
    const canOpen = r && r.status === 'completed';

    toolbar.append(
      btn('Pause', 'pause', () => pauseSelected(r), { disabled: !canPause }),
      btn('Resume', 'play', () => resumeSelected(r), { disabled: !canResume }),
      btn('Cancel', 'x', () => cancelSelected(r), { disabled: !canCancel }),
      btn('Retry', 'retry', () => retrySelected(r), { disabled: !canRetry }),
      h('span', { class: 'toolbar-sep', 'aria-hidden': 'true' }),
      btn('Open file', 'file', () => guard(ctx.api.downloads.openFile(r.id)), { disabled: !canOpen }),
      btn('Open folder', 'folder', () => guard(ctx.api.downloads.showInFolder(r.id)), { disabled: none }),
      btn('Copy URL', 'link', () => guard(ctx.api.downloads.copyUrl(r.id), 'URL copied to clipboard'), { disabled: none }),
      btn('Details', 'info', () => showDetails(r), { disabled: none }),
      btn('Error details', 'alert', () => showError(r), { disabled: none || !(r.error_code || r.error_message) }),
      btn('Remove', 'trash', () => removeSelected(), { disabled: none || r.status === 'downloading', cls: 'btn-danger' }),
    );
  }

  async function pauseSelected(r) {
    if (!r) return;
    await guard(ctx.api.downloads.pause(r.id), `Paused "${r.filename}"`);
    await refresh();
    ctx.refreshStats();
  }

  async function resumeSelected(r) {
    if (!r) return;
    await guard(ctx.api.downloads.resume(r.id), `Resumed "${r.filename}"`);
    await refresh();
    ctx.refreshStats();
  }

  async function cancelSelected(r) {
    if (!r) return;
    const ok = await confirmDialog({
      title: 'Cancel download?',
      message: `Stop downloading "${r.filename}"? Incomplete data will be preserved unless deleted.`,
      confirmLabel: 'Cancel Download',
      danger: true,
    });
    if (!ok) return;
    await guard(ctx.api.downloads.cancel(r.id, false), `Canceled "${r.filename}"`);
    await refresh();
    ctx.refreshStats();
  }

  async function retrySelected(r) {
    if (!r) return;
    await guard(ctx.api.downloads.retry(r.id), `Retrying "${r.filename}"`);
    await refresh();
    ctx.refreshStats();
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

  async function showDetails(r) {
    if (!r) return;
    let details = r;
    try {
      const full = await ctx.api.downloads.details(r.id);
      if (full) details = full;
    } catch {}

    const tel = details.telemetry || ctx.liveStats.get(r.id) || null;
    const isSeg = details.is_segmented === 1 || (tel && tel.isSegmented);

    const infoList = [
      h('div', { class: 'field' }, h('label', { text: 'Filename' }), h('div', { class: 'text-strong', text: details.filename })),
      h('div', { class: 'field' }, h('label', { text: 'Source URL' }), h('div', { class: 'path-display', text: details.source_url })),
      h('div', { class: 'field' }, h('label', { text: 'Destination Folder' }), h('div', { text: details.destination_path })),
      h('div', { class: 'field' }, h('label', { text: 'Status' }), h('span', { class: 'status-pill' }, details.status)),
      h('div', { class: 'field' }, h('label', { text: 'Transfer Progress' }), h('div', { text: `${formatBytes(details.downloaded_bytes)} of ${details.total_bytes ? formatBytes(details.total_bytes) : 'Unknown'} (${percent(details.downloaded_bytes, details.total_bytes)?.toFixed(1) || 0}%)` })),
      h('div', { class: 'field' }, h('label', { text: 'Transfer Mode' }), h('div', { text: isSeg ? `Multi-Segment Accelerated (${details.segment_count || (tel ? tel.totalSegments : 8)} parallel connections)` : 'Single-Connection HTTP' })),
    ];

    if (details.fallback_reason) {
      infoList.push(h('div', { class: 'field' }, h('label', { text: 'Fallback Note' }), h('div', { class: 'field-hint', text: details.fallback_reason })));
    }

    if (tel && tel.segments && tel.segments.length) {
      const segRows = tel.segments.map((s) => {
        const segPct = s.expected > 0 ? Math.min(100, Math.max(0, Math.round((s.downloaded / s.expected) * 100))) : 0;
        const fill = h('span');
        fill.style.width = `${segPct}%`;
        return h('div', { class: 'segment-row' },
          h('div', { class: 'segment-row-header' },
            h('span', { text: `Part #${s.index + 1} (${formatBytes(s.start)}–${formatBytes(s.end)})` }),
            h('span', { text: `${segPct}% [${s.status}]` })),
          h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': segPct }, fill));
      });

      infoList.push(
        h('div', { class: 'field' },
          h('label', { text: `Parallel Connection Segments (${tel.completedSegments || 0}/${tel.totalSegments || 0} Complete)` }),
          h('div', { class: 'segment-list' }, ...segRows))
      );
    }

    openModal((close) => ({
      title: 'Download Properties & Details',
      body: infoList,
      actions: [h('button', { class: 'btn btn-primary', type: 'button', onclick: () => close() }, 'Close')],
    }));
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
    onProgress(payload) {
      const tr = tableHost.querySelector(`tr[data-id="${payload.id}"]`);
      if (!tr) return;

      const r = rows.find((x) => x.id === payload.id);
      if (r) {
        r.downloaded_bytes = payload.downloadedBytes;
        if (payload.totalBytes !== null) r.total_bytes = payload.totalBytes;
      }

      const pct = percent(payload.downloadedBytes, payload.totalBytes);
      const progSpan = tr.querySelector('.progress > span');
      if (progSpan && pct !== null) {
        progSpan.style.width = `${pct}%`;
      }
      const pctLabel = tr.querySelector('.progress-cell small');
      if (pctLabel) {
        pctLabel.textContent = pct !== null ? `${pct.toFixed(0)}%` : '—';
      }

      const tds = tr.querySelectorAll('td');
      if (tds[4]) tds[4].textContent = formatBytes(payload.downloadedBytes);
      if (tds[6]) tds[6].textContent = formatSpeed(payload.currentSpeed);
      if (tds[7]) tds[7].textContent = formatEta(payload.etaSeconds);
    },
    dispose() { disposed = true; },
  };
}
