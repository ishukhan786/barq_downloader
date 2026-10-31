// BARQ Downloader — World-Class Dashboard UI/UX View
import { h, icon, clear, svgEl } from '../dom.js';
import { formatBytes, formatEta, formatSpeed, percent, relativeTime } from '../format.js';
import { toast, guard } from '../ui.js';

const CATEGORY_ICON = {
  video: 'video',
  audio: 'audio',
  document: 'document',
  archive: 'archive',
  program: 'program',
  image: 'image',
  other: 'file',
};

export function renderDashboard(root, ctx) {
  let disposed = false;
  let activeCardsMap = new Map(); // downloadId -> { progressBar, pctEl, speedEl, etaEl, bytesEl }

  // 1. Hero Section with Integrated Quick Download Bar
  const heroUrlInput = h('input', {
    class: 'input quick-bar-input',
    type: 'url',
    placeholder: 'Paste direct download link here (http:// or https://)...',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: 2000,
  });

  const heroFeedback = h('div', { class: 'quick-bar-feedback' });

  async function handleQuickDownload() {
    const rawUrl = heroUrlInput.value.trim();
    if (!rawUrl) {
      heroFeedback.className = 'quick-bar-feedback error';
      heroFeedback.textContent = 'Please enter or paste a valid download URL.';
      heroUrlInput.focus();
      return;
    }

    heroFeedback.className = 'quick-bar-feedback info';
    heroFeedback.textContent = 'Validating and accelerating link...';

    try {
      const valRes = await ctx.api.downloads.validateUrl(rawUrl);
      if (!valRes.ok) {
        heroFeedback.className = 'quick-bar-feedback error';
        heroFeedback.textContent = valRes.error || 'Invalid download URL.';
        return;
      }

      const record = await ctx.api.downloads.add({
        url: valRes.url,
        startNow: true,
      });

      heroUrlInput.value = '';
      heroFeedback.className = 'quick-bar-feedback ok';
      heroFeedback.textContent = `Accelerating "${record.filename}"...`;
      toast(`Started download for "${record.filename}"`, 'ok');

      setTimeout(() => {
        if (!disposed && heroFeedback.className.includes('ok')) {
          heroFeedback.textContent = '';
        }
      }, 4000);

      await refresh();
      if (ctx.refreshStats) ctx.refreshStats();
    } catch (err) {
      heroFeedback.className = 'quick-bar-feedback error';
      heroFeedback.textContent = err.message || 'Download initialization failed.';
      toast(err.message, 'error');
    }
  }

  const pasteBtn = h('button', {
    class: 'btn btn-quick-paste',
    type: 'button',
    title: 'Paste from Clipboard',
    onclick: async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
          heroUrlInput.value = text.trim();
          heroFeedback.className = 'quick-bar-feedback ok';
          heroFeedback.textContent = 'Link pasted from clipboard.';
          heroUrlInput.focus();
        } else if (text) {
          heroUrlInput.value = text.trim();
          heroFeedback.className = 'quick-bar-feedback';
          heroFeedback.textContent = 'Clipboard text pasted. Make sure it is a valid HTTP/HTTPS URL.';
        } else {
          toast('Clipboard is empty', 'info');
        }
      } catch (err) {
        toast('Clipboard permission required', 'warn');
      }
    },
  }, icon('paste'), 'Paste');

  const downloadBtn = h('button', {
    class: 'btn btn-primary btn-quick-submit',
    type: 'button',
    title: 'Download Immediately',
    onclick: handleQuickDownload,
  }, icon('bolt'), 'Download');

  const optionsBtn = h('button', {
    class: 'btn btn-quick-opts',
    type: 'button',
    title: 'Advanced Options (Destination, Custom Filename)',
    onclick: () => ctx.openAddDownload(heroUrlInput.value.trim()),
  }, icon('plus'), 'Options…');

  heroUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleQuickDownload();
    }
  });

  const heroSection = h('section', { class: 'card hero-card' },
    h('div', { class: 'hero-header-row' },
      h('div', { class: 'hero-identity' },
        h('div', { class: 'hero-mark-wrap' },
          h('img', { src: 'assets/brand/barq-mark.svg', alt: 'BARQ', width: 44, height: 44 })),
        h('div', { class: 'hero-text' },
          h('div', { class: 'hero-title-wrap' },
            h('span', { class: 'hero-wordmark', text: 'BARQ Downloader' }),
            h('span', { class: 'hero-urdu', lang: 'ur', dir: 'rtl', text: 'برق ڈاؤنلوڈر' })),
          h('p', { class: 'hero-tagline', text: 'Speed at Every Click. Multi-stream parallel acceleration engine.' }))),
      h('div', { class: 'hero-badges' },
        h('span', { class: 'hero-status-pill' },
          h('span', { class: 'pulse-dot pulse-ok' }),
          'Engine v0.1.0 Online'))),
    h('div', { class: 'quick-bar-container' },
      h('div', { class: 'quick-bar-wrapper' },
        icon('download', 'icon-quick-bar'),
        heroUrlInput,
        pasteBtn,
        optionsBtn,
        downloadBtn),
      heroFeedback));

  // 2. High-Impact Stat Cards Grid (4 Cards)
  const statCard = (id, label, subtext, iconName, accentClass = '') =>
    h('div', { class: `card stat-card ${accentClass}` },
      h('div', { class: 'stat-header' },
        h('span', { class: 'stat-label-text', text: label }),
        h('div', { class: 'stat-icon-wrap' }, icon(iconName))),
      h('div', { class: 'stat-metric-row' },
        h('span', { class: 'stat-metric', id: `metric-${id}`, text: '—' }),
        id === 'active' ? h('span', { class: 'live-speed-pill', id: 'metric-active-speed' },
          h('span', { class: 'pulse-dot' }),
          h('span', { id: 'metric-active-speed-text', text: '0 B/s' })) : null),
      h('div', { class: 'stat-footer' },
        h('span', { class: 'stat-subtext', text: subtext })));

  const statsGrid = h('div', { class: 'stats-grid-4' },
    statCard('total', 'Total Downloads', 'Lifetime download tasks', 'database', 'stat-card-total'),
    statCard('active', 'Active Transfers', 'Simultaneous parallel streams', 'bolt', 'stat-card-active'),
    statCard('completed', 'Completed', 'Bit-for-bit verified on disk', 'checkCircle', 'stat-card-completed'),
    statCard('bandwidth', 'Data Downloaded', 'High-speed data delivered', 'trending', 'stat-card-bandwidth'));

  // 3. Active Downloads Section (Live Transfer Cards)
  const activeDownloadsList = h('div', { class: 'active-downloads-container' });
  const activeDownloadsCard = h('section', { class: 'card dash-panel active-transfers-panel' },
    h('div', { class: 'panel-header' },
      h('div', { class: 'panel-header-title' },
        icon('bolt', 'panel-icon-accent'),
        h('h2', { text: 'Active Transfers' }),
        h('span', { class: 'panel-counter', id: 'active-counter-badge', text: '0' })),
      h('button', {
        class: 'btn btn-sm btn-ghost',
        type: 'button',
        onclick: () => ctx.navigate('downloading'),
      }, 'All Transfers →')),
    activeDownloadsList);

  // 4. Download Activity Area Chart (SVG)
  const chartWrapper = h('div', { class: 'chart-container' });
  const chartCard = h('section', { class: 'card dash-panel activity-chart-panel' },
    h('div', { class: 'panel-header' },
      h('div', { class: 'panel-header-title' },
        icon('chart', 'panel-icon-cyan'),
        h('h2', { text: 'Download Activity' })),
      h('span', { class: 'chart-period-badge', text: 'Recent Transfer Volume' })),
    chartWrapper);

  // 5. Recent Completed Downloads Section
  const recentDownloadsList = h('div', { class: 'recent-downloads-container' });
  const recentDownloadsCard = h('section', { class: 'card dash-panel recent-panel' },
    h('div', { class: 'panel-header' },
      h('div', { class: 'panel-header-title' },
        icon('check', 'panel-icon-green'),
        h('h2', { text: 'Recent Downloads' })),
      h('button', {
        class: 'btn btn-sm btn-ghost',
        type: 'button',
        onclick: () => ctx.navigate('completed'),
      }, 'View Completed →')),
    recentDownloadsList);

  // 6. Recent System Activity Feed
  const activityListEl = h('ul', { class: 'activity-feed' });
  const activityCard = h('section', { class: 'card dash-panel feed-panel' },
    h('div', { class: 'panel-header' },
      h('div', { class: 'panel-header-title' },
        icon('activity', 'panel-icon-purple'),
        h('h2', { text: 'Engine Events' }))),
    activityListEl);

  // Layout Grid: Active Downloads (full width or 2-col), Chart & Recents, Feed
  const midGrid = h('div', { class: 'dash-layout-grid' },
    h('div', { class: 'dash-col-primary' },
      activeDownloadsCard,
      recentDownloadsCard),
    h('div', { class: 'dash-col-secondary' },
      chartCard,
      activityCard));

  root.append(
    h('div', { class: 'view-header' },
      h('div', {},
        h('h1', { text: 'Overview Dashboard' }),
        h('p', { class: 'view-sub', text: 'Live performance telemetry, active downloads, and quick actions.' }))),
    heroSection,
    statsGrid,
    midGrid,
  );

  function getDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return 'direct stream';
    }
  }

  function renderEmptyActive() {
    clear(activeDownloadsList);
    activeDownloadsList.append(
      h('div', { class: 'empty-active-state' },
        h('div', { class: 'empty-active-icon-glow' },
          icon('zap', 'empty-zap-icon')),
        h('h3', { text: 'Engine Standing By' }),
        h('p', { text: 'No active transfers right now. Paste any direct HTTP/HTTPS download link above to experience multi-segment acceleration.' }),
        h('button', {
          class: 'btn btn-sm btn-primary',
          type: 'button',
          onclick: () => ctx.openAddDownload(),
        }, icon('plus'), 'Add First Download'))
    );
  }

  function renderActiveDownloads(downloads) {
    clear(activeDownloadsList);
    activeCardsMap.clear();

    if (!downloads || downloads.length === 0) {
      renderEmptyActive();
      return;
    }

    for (const item of downloads) {
      const pct = percent(item.downloaded_bytes, item.total_bytes);
      const isIndet = pct === null;
      const pctText = isIndet ? 'Indeterminate' : `${Math.round(pct)}%`;

      const progressBarFill = h('div', { class: `live-progress-fill${isIndet ? ' indeterminate' : ''}` });
      if (!isIndet) {
        progressBarFill.style.width = `${pct}%`;
      }

      const progressBarTrack = h('div', { class: 'live-progress-track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, ...(isIndet ? {} : { 'aria-valuenow': Math.round(pct) }) },
        progressBarFill);

      const pctEl = h('span', { class: 'live-pct-val', text: pctText });
      const speedEl = h('span', { class: 'live-stat-val', text: formatSpeed(item.speedBps || 0) });
      const etaEl = h('span', { class: 'live-stat-val', text: formatEta(item.etaSeconds) });
      const bytesEl = h('span', { class: 'live-bytes-val', text: `${formatBytes(item.downloaded_bytes)} / ${formatBytes(item.total_bytes)}` });

      activeCardsMap.set(item.id, {
        progressBarFill,
        pctEl,
        speedEl,
        etaEl,
        bytesEl,
      });

      const catIcon = CATEGORY_ICON[item.category] || 'file';
      const segCount = item.segment_count || item.connections || (item.supports_ranges ? 8 : 1);

      const pauseResumeBtn = h('button', {
        class: 'btn-icon-action',
        type: 'button',
        title: item.status === 'downloading' ? 'Pause Download' : 'Resume Download',
        onclick: async () => {
          if (item.status === 'downloading') {
            await guard(ctx.api.downloads.pause(item.id));
          } else {
            await guard(ctx.api.downloads.resume(item.id));
          }
          await refresh();
        },
      }, icon(item.status === 'downloading' ? 'pause' : 'play'));

      const cancelBtn = h('button', {
        class: 'btn-icon-action btn-action-danger',
        type: 'button',
        title: 'Cancel & Remove',
        onclick: async () => {
          await guard(ctx.api.downloads.cancel(item.id, false));
          await refresh();
        },
      }, icon('x'));

      const card = h('div', { class: 'live-download-card', dataset: { id: item.id } },
        h('div', { class: 'live-card-top' },
          h('div', { class: 'live-file-icon' }, icon(catIcon)),
          h('div', { class: 'live-file-details' },
            h('span', { class: 'live-filename', text: item.filename, title: item.filename }),
            h('div', { class: 'live-meta-row' },
              h('span', { class: 'live-domain', text: getDomain(item.url) }),
              h('span', { class: 'meta-sep' }, '•'),
              h('span', { class: 'segment-badge' }, icon('layers'), `${segCount} Segments`))),
          h('div', { class: 'live-actions' },
            pauseResumeBtn,
            cancelBtn)),
        h('div', { class: 'live-progress-container' },
          progressBarTrack),
        h('div', { class: 'live-stats-row' },
          h('div', { class: 'live-stat-group' },
            h('span', { class: 'live-stat-label', text: 'Progress: ' }),
            pctEl),
          h('div', { class: 'live-stat-group' },
            h('span', { class: 'live-stat-label', text: 'Speed: ' }),
            speedEl),
          h('div', { class: 'live-stat-group' },
            h('span', { class: 'live-stat-label', text: 'ETA: ' }),
            etaEl),
          h('div', { class: 'live-stat-group ml-auto' },
            bytesEl)));

      activeDownloadsList.append(card);
    }
  }

  function renderChart(completedDownloads) {
    clear(chartWrapper);

    const svgWidth = 560;
    const svgHeight = 150;
    const padX = 35;
    const padY = 24;
    const chartW = svgWidth - padX * 2;
    const chartH = svgHeight - padY * 2;

    // Build data points from completed downloads (up to 7 items or synthetic baseline)
    const dataPoints = [];
    if (completedDownloads && completedDownloads.length > 0) {
      const sorted = [...completedDownloads].slice(0, 7).reverse();
      for (const d of sorted) {
        dataPoints.push({
          label: d.filename ? (d.filename.length > 12 ? d.filename.slice(0, 10) + '…' : d.filename) : 'File',
          value: d.total_bytes || 1024 * 1024,
        });
      }
    }

    // Ensure we have at least 5 points for a beautiful chart curve
    while (dataPoints.length < 5) {
      const idx = dataPoints.length;
      dataPoints.push({
        label: `T-${5 - idx}`,
        value: 1024 * 1024 * (idx + 1) * 2,
      });
    }

    const maxVal = Math.max(...dataPoints.map((d) => d.value), 1024 * 1024 * 5);
    const coords = dataPoints.map((pt, i) => {
      const x = padX + (i / (dataPoints.length - 1)) * chartW;
      const y = padY + chartH - (pt.value / maxVal) * chartH;
      return { x, y, pt };
    });

    // Smooth path generation
    let lineD = `M ${coords[0].x} ${coords[0].y}`;
    for (let i = 0; i < coords.length - 1; i++) {
      const p0 = coords[i];
      const p1 = coords[i + 1];
      const cpX = (p0.x + p1.x) / 2;
      lineD += ` C ${cpX} ${p0.y}, ${cpX} ${p1.y}, ${p1.x} ${p1.y}`;
    }

    const areaD = `${lineD} L ${coords[coords.length - 1].x} ${padY + chartH} L ${coords[0].x} ${padY + chartH} Z`;

    const svg = svgEl('svg', {
      class: 'activity-svg',
      viewBox: `0 0 ${svgWidth} ${svgHeight}`,
      preserveAspectRatio: 'none',
    },
      svgEl('defs', {},
        svgEl('linearGradient', { id: 'barq-chart-grad', x1: '0', y1: '0', x2: '0', y2: '1' },
          svgEl('stop', { offset: '0%', 'stop-color': '#16E0A0', 'stop-opacity': '0.36' }),
          svgEl('stop', { offset: '80%', 'stop-color': '#00B8D9', 'stop-opacity': '0.06' }),
          svgEl('stop', { offset: '100%', 'stop-color': '#0B0F14', 'stop-opacity': '0' })),
        svgEl('filter', { id: 'glow' },
          svgEl('feGaussianBlur', { stdDeviation: '2.5', result: 'coloredBlur' }),
          svgEl('feMerge', {},
            svgEl('feMergeNode', { in: 'coloredBlur' }),
            svgEl('feMergeNode', { in: 'SourceGraphic' })))),
      // Grid lines
      svgEl('line', { class: 'chart-gridline', x1: padX, y1: padY, x2: padX + chartW, y2: padY }),
      svgEl('line', { class: 'chart-gridline', x1: padX, y1: padY + chartH / 2, x2: padX + chartW, y2: padY + chartH / 2 }),
      svgEl('line', { class: 'chart-gridline', x1: padX, y1: padY + chartH, x2: padX + chartW, y2: padY + chartH }),
      // Fill and Stroke
      svgEl('path', { class: 'chart-area', d: areaD, fill: 'url(#barq-chart-grad)' }),
      svgEl('path', { class: 'chart-line', d: lineD, fill: 'none', stroke: '#16E0A0', 'stroke-width': '2.5', filter: 'url(#glow)' }),
      // Interactive points
      ...coords.map((c) =>
        svgEl('g', { class: 'chart-dot-group' },
          svgEl('circle', { class: 'chart-dot-outer', cx: c.x, cy: c.y, r: 6 }),
          svgEl('circle', { class: 'chart-dot', cx: c.x, cy: c.y, r: 3.5, fill: '#16E0A0' }))));

    chartWrapper.append(svg);
  }

  function renderRecent(completedList) {
    clear(recentDownloadsList);

    if (!completedList || completedList.length === 0) {
      recentDownloadsList.append(
        h('div', { class: 'empty-recent' },
          h('p', { text: 'No completed downloads recorded yet.' }))
      );
      return;
    }

    const items = completedList.slice(0, 5);
    for (const item of items) {
      const catIcon = CATEGORY_ICON[item.category] || 'file';

      const openFileBtn = h('button', {
        class: 'btn-icon-sm',
        type: 'button',
        title: 'Open Downloaded File',
        onclick: () => ctx.api.downloads.openFile(item.id),
      }, icon('external'));

      const openFolderBtn = h('button', {
        class: 'btn-icon-sm',
        type: 'button',
        title: 'Show in Folder',
        onclick: () => ctx.api.downloads.openFolder(item.id),
      }, icon('folder'));

      const copyLinkBtn = h('button', {
        class: 'btn-icon-sm',
        type: 'button',
        title: 'Copy Source URL',
        onclick: async () => {
          await navigator.clipboard.writeText(item.url);
          toast('Download URL copied to clipboard', 'ok');
        },
      }, icon('copy'));

      const row = h('div', { class: 'recent-row' },
        h('div', { class: 'recent-icon-wrap' }, icon(catIcon)),
        h('div', { class: 'recent-info' },
          h('span', { class: 'recent-filename', text: item.filename, title: item.filename }),
          h('div', { class: 'recent-meta' },
            h('span', { class: 'recent-size', text: formatBytes(item.total_bytes) }),
            h('span', { class: 'meta-sep' }, '•'),
            h('span', { class: 'recent-time', text: relativeTime(item.completed_at) }))),
        h('div', { class: 'recent-actions' },
          openFileBtn,
          openFolderBtn,
          copyLinkBtn));

      recentDownloadsList.append(row);
    }
  }

  function renderActivity(activities) {
    clear(activityListEl);

    if (!activities || activities.length === 0) {
      activityListEl.append(
        h('li', { class: 'activity-empty' },
          h('span', { text: 'No recent events recorded.' }))
      );
      return;
    }

    for (const act of activities.slice(0, 8)) {
      const dotCls = act.level === 'warn' ? 'dot-warn' : act.level === 'error' ? 'dot-error' : act.level === 'ok' ? 'dot-ok' : 'dot-info';
      activityListEl.append(
        h('li', { class: 'activity-item' },
          h('span', { class: `dot ${dotCls}` }),
          h('span', { class: 'activity-msg', text: act.message }),
          h('time', { class: 'activity-time', text: relativeTime(act.created_at) }))
      );
    }
  }

  async function refresh() {
    try {
      const [stats, activeList, completedList, activities] = await Promise.all([
        ctx.api.stats.get(),
        ctx.api.downloads.list({ view: 'downloading' }),
        ctx.api.downloads.list({ view: 'completed', limit: 10 }),
        ctx.api.activity.recent(15),
      ]);

      if (disposed) return;

      // Update 4 Stat Cards
      const setMetric = (id, val) => {
        const el = document.getElementById(`metric-${id}`);
        if (el) el.textContent = String(val);
      };

      setMetric('total', stats.total ?? 0);
      setMetric('active', stats.active ?? 0);
      setMetric('completed', stats.completed ?? 0);
      setMetric('bandwidth', formatBytes(stats.total_downloaded_bytes || stats.completed_bytes || 0));

      const spdText = document.getElementById('metric-active-speed-text');
      if (spdText) spdText.textContent = formatSpeed(stats.overallSpeedBps || 0);

      const activeBadge = document.getElementById('active-counter-badge');
      if (activeBadge) activeBadge.textContent = String(stats.active ?? 0);

      // Render sections
      renderActiveDownloads(activeList);
      renderChart(completedList);
      renderRecent(completedList);
      renderActivity(activities);
    } catch (err) {
      if (!disposed) console.warn('Dashboard refresh error:', err);
    }
  }

  function onProgress(payload) {
    if (disposed) return;
    const cardRefs = activeCardsMap.get(payload.id);
    if (!cardRefs) return;

    const pct = percent(payload.downloadedBytes, payload.totalBytes);
    const isIndet = pct === null;

    if (!isIndet) {
      cardRefs.progressBarFill.classList.remove('indeterminate');
      cardRefs.progressBarFill.style.width = `${pct}%`;
      cardRefs.pctEl.textContent = `${Math.round(pct)}%`;
    } else {
      cardRefs.progressBarFill.classList.add('indeterminate');
      cardRefs.pctEl.textContent = 'Indeterminate';
    }

    cardRefs.speedEl.textContent = formatSpeed(payload.speedBps || 0);
    cardRefs.etaEl.textContent = formatEta(payload.etaSeconds);
    cardRefs.bytesEl.textContent = `${formatBytes(payload.downloadedBytes)} / ${formatBytes(payload.totalBytes)}`;

    const spdText = document.getElementById('metric-active-speed-text');
    if (spdText && payload.speedBps !== undefined) {
      spdText.textContent = formatSpeed(payload.speedBps);
    }
  }

  refresh();

  return {
    refresh,
    onProgress,
    dispose() {
      disposed = true;
    },
  };
}
