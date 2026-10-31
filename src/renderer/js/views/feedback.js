// BARQ Downloader — Feedback, Diagnostics & Support Center
import { h, icon, clear } from '../dom.js';
import { formatBytes, relativeTime } from '../format.js';
import { openModal, confirmDialog, toast, guard } from '../ui.js';

const BUG_CATEGORIES = [
  { value: 'download_failure', label: 'Download Stalled / Failed' },
  { value: 'speed_performance', label: 'Slow Download Speed' },
  { value: 'pause_resume', label: 'Pause & Resume Failure' },
  { value: 'multi_segment', label: 'Multi-Segment Acceleration' },
  { value: 'ui_ux', label: 'Interface / Display Bug' },
  { value: 'browser_extension', label: 'Browser Extension Bridge' },
  { value: 'crash_freeze', label: 'Application Crash / Freeze' },
  { value: 'other', label: 'Other Issue' },
];

const FEATURE_CATEGORIES = [
  { value: 'download_engine', label: 'Download Engine & Acceleration' },
  { value: 'user_interface', label: 'User Interface & Themes' },
  { value: 'browser_integration', label: 'Browser Integration' },
  { value: 'queue_scheduling', label: 'Queue & Scheduling' },
  { value: 'automation', label: 'Automation & CLI' },
  { value: 'other', label: 'Other Enhancement' },
];

const SEVERITY_LEVELS = [
  { value: 'low', label: 'Low — Minor annoyance / cosmetic' },
  { value: 'medium', label: 'Medium — Feature partially impaired' },
  { value: 'high', label: 'High — Download blocked or failing' },
  { value: 'critical', label: 'Critical — Crash, freeze, or data loss' },
];

export function renderFeedback(root, ctx) {
  let activeTab = 'bug';
  let reports = [];
  let stats = { total: 0, bugs: 0, features: 0, drafts: 0, saved: 0, exported: 0 };
  let searchTerm = '';
  let statusFilter = 'all';
  let disposed = false;

  const container = h('div', { class: 'feedback-view' });

  root.append(
    h('div', { class: 'view-header' },
      h('div', {},
        h('div', { class: 'hero-title-wrap' },
          h('h1', { text: 'Feedback & Support' }),
          h('span', { class: 'hero-urdu', lang: 'ur', dir: 'rtl', text: 'رائے اور معاونت' })),
        h('p', { class: 'view-sub', text: 'Report bugs, suggest features, review privacy-first diagnostics, or explore troubleshooting guides. Zero background telemetry.' })),
      h('div', { class: 'view-header-actions' },
        h('button', {
          class: 'btn btn-secondary',
          type: 'button',
          title: 'Inspect sanitized diagnostic data before export',
          onclick: () => showDiagnosticPreviewModal(ctx),
        }, icon('shield'), 'Preview Diagnostics'),
        h('button', {
          class: 'btn btn-primary',
          type: 'button',
          title: 'Export full diagnostic ZIP package with explicit consent',
          onclick: async () => {
            const res = await guard(ctx.api.feedback.exportZip({ includeDiagnostics: true }));
            if (res && !res.canceled && res.path) {
              toast(`Exported diagnostic package (${(res.bytes / 1024).toFixed(1)} KB)`, 'ok');
              await loadStats();
              await loadReports();
            }
          },
        }, icon('export'), 'Export Diagnostics ZIP'))),
    container,
  );

  async function loadStats() {
    try {
      const res = await ctx.api.feedback.getStats();
      if (res) stats = res;
    } catch (err) {
      console.warn('Failed to load feedback stats:', err);
    }
  }

  async function loadReports() {
    try {
      const opts = { limit: 100 };
      if (statusFilter !== 'all') {
        if (statusFilter === 'bug' || statusFilter === 'feature') opts.type = statusFilter;
        else opts.status = statusFilter;
      }
      if (searchTerm) opts.search = searchTerm;
      const res = await ctx.api.feedback.list(opts);
      if (Array.isArray(res)) reports = res;
    } catch (err) {
      console.warn('Failed to load feedback reports:', err);
    }
  }

  function render() {
    clear(container);

    // 1. Metric Cards
    const metricsGrid = h('div', { class: 'feedback-stats-grid' },
      h('div', { class: 'card stat-card' },
        h('div', { class: 'stat-header' },
          h('span', { class: 'stat-label-text', text: 'Total Reports' }),
          icon('document', 'stat-header-icon')),
        h('div', { class: 'stat-metric-wrap' },
          h('span', { class: 'stat-main-metric', text: String(stats.total) })),
        h('span', { class: 'stat-subtext', text: 'Locally saved records' })),

      h('div', { class: 'card stat-card' },
        h('div', { class: 'stat-header' },
          h('span', { class: 'stat-label-text', text: 'Bug Reports' }),
          icon('bug', 'stat-header-icon')),
        h('div', { class: 'stat-metric-wrap' },
          h('span', { class: 'stat-main-metric', text: String(stats.bugs) })),
        h('span', { class: 'stat-subtext', text: 'Issues documented' })),

      h('div', { class: 'card stat-card' },
        h('div', { class: 'stat-header' },
          h('span', { class: 'stat-label-text', text: 'Feature Ideas' }),
          icon('sparkles', 'stat-header-icon')),
        h('div', { class: 'stat-metric-wrap' },
          h('span', { class: 'stat-main-metric', text: String(stats.features) })),
        h('span', { class: 'stat-subtext', text: 'Improvement requests' })),

      h('div', { class: 'card stat-card' },
        h('div', { class: 'stat-header' },
          h('span', { class: 'stat-label-text', text: 'Exported Bundles' }),
          icon('export', 'stat-header-icon')),
        h('div', { class: 'stat-metric-wrap' },
          h('span', { class: 'stat-main-metric', text: String(stats.exported) })),
        h('span', { class: 'stat-subtext', text: 'Shared diagnostic archives' })),
    );

    // 2. Tab Navigation Bar
    const tabs = [
      { id: 'bug', label: 'Report a Bug', icon: 'bug' },
      { id: 'feature', label: 'Suggest a Feature', icon: 'sparkles' },
      { id: 'reports', label: `My Reports (${stats.total})`, icon: 'document' },
      { id: 'troubleshoot', label: 'Troubleshooting & Support', icon: 'help' },
    ];

    const tabNav = h('div', { class: 'feedback-tabs', role: 'tablist' },
      ...tabs.map((tab) => {
        const btn = h('button', {
          class: `feedback-tab-btn ${activeTab === tab.id ? 'active' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': activeTab === tab.id ? 'true' : 'false',
          onclick: async () => {
            activeTab = tab.id;
            if (activeTab === 'reports') await loadReports();
            render();
          },
        }, icon(tab.icon), h('span', { text: tab.label }));
        return btn;
      }),
    );

    // 3. Tab Panel Content
    const panel = h('div', { class: 'feedback-tab-panel' });
    if (activeTab === 'bug') {
      panel.appendChild(renderBugForm());
    } else if (activeTab === 'feature') {
      panel.appendChild(renderFeatureForm());
    } else if (activeTab === 'reports') {
      panel.appendChild(renderReportsList());
    } else if (activeTab === 'troubleshoot') {
      panel.appendChild(renderTroubleshooting());
    }

    container.append(metricsGrid, tabNav, panel);
  }

  // ---------------------------------------------------------------------------
  // TAB 1: BUG REPORT FORM
  // ---------------------------------------------------------------------------
  function renderBugForm() {
    const card = h('div', { class: 'card feedback-card' });

    const titleInput = h('input', {
      class: 'input input-wide',
      type: 'text',
      placeholder: 'Brief, clear summary of the problem (e.g. Download stalls at 99% during merge)',
      required: true,
      maxlength: 200,
    });

    const categorySelect = h('select', { class: 'input' },
      ...BUG_CATEGORIES.map((c) => h('option', { value: c.value, text: c.label })));

    const severitySelect = h('select', { class: 'input' },
      ...SEVERITY_LEVELS.map((s) => {
        const opt = h('option', { value: s.value, text: s.label });
        if (s.value === 'medium') opt.selected = true;
        return opt;
      }));

    const descTextarea = h('textarea', {
      class: 'input textarea-tall',
      placeholder: 'Describe what happened, what went wrong, and any error message displayed...',
      required: true,
      rows: 4,
    });

    const stepsTextarea = h('textarea', {
      class: 'input textarea-medium',
      placeholder: '1. Paste link into Quick Download bar\n2. Start download\n3. Observe progress freezes...',
      rows: 3,
    });

    const expectedTextarea = h('textarea', {
      class: 'input textarea-medium',
      placeholder: 'What did you expect to happen?',
      rows: 2,
    });

    const actualTextarea = h('textarea', {
      class: 'input textarea-medium',
      placeholder: 'What happened instead?',
      rows: 2,
    });

    const diagCheckbox = h('input', {
      type: 'checkbox',
      id: 'bug-diag-check',
      checked: false, // OPT-IN BY DEFAULT (Milestone 7.1 Privacy Mandate)
    });

    async function handleSave(status = 'saved') {
      const title = titleInput.value.trim();
      const description = descTextarea.value.trim();

      if (!title) {
        toast('Please provide a title for the bug report.', 'error');
        titleInput.focus();
        return;
      }
      if (!description) {
        toast('Please describe the problem.', 'error');
        descTextarea.focus();
        return;
      }

      const payload = {
        report_type: 'bug',
        title,
        category: categorySelect.value,
        severity: severitySelect.value,
        description,
        reproduction_steps: stepsTextarea.value.trim() || null,
        expected_behavior: expectedTextarea.value.trim() || null,
        actual_behavior: actualTextarea.value.trim() || null,
        status,
        diagnostic_included: diagCheckbox.checked ? 1 : 0,
      };

      const res = await guard(ctx.api.feedback.save(payload));
      if (res) {
        toast(status === 'draft' ? 'Bug report draft saved.' : `Bug report saved (#${res.report_id}).`, 'ok');
        await loadStats();
        activeTab = 'reports';
        await loadReports();
        render();
      }
    }

    card.append(
      h('div', { class: 'feedback-form-head' },
        h('h2', { text: 'Report an Issue or Bug' }),
        h('p', { class: 'section-sub', text: 'All information is saved locally in your BARQ database. Zero telemetry is sent online.' })),

      h('div', { class: 'form-group' },
        h('label', { class: 'form-label', text: 'Bug Title *' }),
        titleInput),

      h('div', { class: 'form-row' },
        h('div', { class: 'form-col' },
          h('label', { class: 'form-label', text: 'Category' }),
          categorySelect),
        h('div', { class: 'form-col' },
          h('label', { class: 'form-label', text: 'Severity Level' }),
          severitySelect)),

      h('div', { class: 'form-group' },
        h('label', { class: 'form-label', text: 'Description of the Problem *' }),
        descTextarea),

      h('div', { class: 'form-group' },
        h('label', { class: 'form-label', text: 'Steps to Reproduce (Optional)' }),
        stepsTextarea),

      h('div', { class: 'form-row' },
        h('div', { class: 'form-col' },
          h('label', { class: 'form-label', text: 'Expected Behavior' }),
          expectedTextarea),
        h('div', { class: 'form-col' },
          h('label', { class: 'form-label', text: 'Actual Behavior' }),
          actualTextarea)),

      h('div', { class: 'feedback-diag-box' },
        h('label', { class: 'checkbox-label' },
          diagCheckbox,
          h('span', { text: 'Attach sanitized system diagnostics (OS, RAM, version, scrubbed error logs)' })),
        h('button', {
          class: 'btn btn-sm btn-subtle',
          type: 'button',
          onclick: () => showDiagnosticPreviewModal(ctx),
        }, icon('shield'), 'Inspect Diagnostic Data')),

      h('div', { class: 'form-actions' },
        h('button', {
          class: 'btn btn-secondary',
          type: 'button',
          onclick: () => handleSave('draft'),
        }, 'Save as Draft'),
        h('button', {
          class: 'btn btn-primary',
          type: 'button',
          onclick: () => handleSave('saved'),
        }, icon('check'), 'Save Bug Report')),
    );

    return card;
  }

  // ---------------------------------------------------------------------------
  // TAB 2: FEATURE REQUEST FORM
  // ---------------------------------------------------------------------------
  function renderFeatureForm() {
    const card = h('div', { class: 'card feedback-card' });

    const titleInput = h('input', {
      class: 'input input-wide',
      type: 'text',
      placeholder: 'Clear title for the feature (e.g. Bandwidth scheduler by time of day)',
      required: true,
      maxlength: 200,
    });

    const categorySelect = h('select', { class: 'input' },
      ...FEATURE_CATEGORIES.map((c) => h('option', { value: c.value, text: c.label })));

    const descTextarea = h('textarea', {
      class: 'input textarea-tall',
      placeholder: 'Explain what capability you would like to have and how it should behave...',
      required: true,
      rows: 4,
    });

    const useCaseTextarea = h('textarea', {
      class: 'input textarea-medium',
      placeholder: 'Describe your use case or why this would improve your downloading experience...',
      rows: 3,
    });

    async function handleSave(status = 'saved') {
      const title = titleInput.value.trim();
      const description = descTextarea.value.trim();

      if (!title) {
        toast('Please enter a feature title.', 'error');
        titleInput.focus();
        return;
      }
      if (!description) {
        toast('Please describe the suggested feature.', 'error');
        descTextarea.focus();
        return;
      }

      const payload = {
        report_type: 'feature',
        title,
        category: categorySelect.value,
        description,
        expected_behavior: useCaseTextarea.value.trim() || null,
        status,
        diagnostic_included: 0,
      };

      const res = await guard(ctx.api.feedback.save(payload));
      if (res) {
        toast(status === 'draft' ? 'Feature request draft saved.' : `Feature request logged (#${res.report_id}).`, 'ok');
        await loadStats();
        activeTab = 'reports';
        await loadReports();
        render();
      }
    }

    card.append(
      h('div', { class: 'feedback-form-head' },
        h('h2', { text: 'Suggest a New Feature or Enhancement' }),
        h('p', { class: 'section-sub', text: 'Help shape future BARQ releases. Saved locally to your reports catalogue.' })),

      h('div', { class: 'form-group' },
        h('label', { class: 'form-label', text: 'Feature Title *' }),
        titleInput),

      h('div', { class: 'form-group' },
        h('label', { class: 'form-label', text: 'Target Category' }),
        categorySelect),

      h('div', { class: 'form-group' },
        h('label', { class: 'form-label', text: 'Detailed Description *' }),
        descTextarea),

      h('div', { class: 'form-group' },
        h('label', { class: 'form-label', text: 'Use Case & Expected Benefit (Optional)' }),
        useCaseTextarea),

      h('div', { class: 'form-actions' },
        h('button', {
          class: 'btn btn-secondary',
          type: 'button',
          onclick: () => handleSave('draft'),
        }, 'Save as Draft'),
        h('button', {
          class: 'btn btn-primary',
          type: 'button',
          onclick: () => handleSave('saved'),
        }, icon('sparkles'), 'Save Feature Request')),
    );

    return card;
  }

  // ---------------------------------------------------------------------------
  // TAB 3: MY REPORTS LIST & MANAGEMENT
  // ---------------------------------------------------------------------------
  function renderReportsList() {
    const wrapper = h('div', { class: 'feedback-reports-container' });

    // Filter Toolbar
    const searchInput = h('input', {
      class: 'input search-input',
      type: 'search',
      placeholder: 'Search reports by title, ID, or description...',
      value: searchTerm,
      oninput: (e) => {
        searchTerm = e.target.value;
        loadReports().then(render);
      },
    });

    const statusDropdown = h('select', {
      class: 'input status-filter-select',
      onchange: (e) => {
        statusFilter = e.target.value;
        loadReports().then(render);
      },
    },
      h('option', { value: 'all', text: 'All Reports' }),
      h('option', { value: 'bug', text: 'Bugs Only' }),
      h('option', { value: 'feature', text: 'Features Only' }),
      h('option', { value: 'draft', text: 'Drafts' }),
      h('option', { value: 'saved', text: 'Saved' }),
      h('option', { value: 'exported', text: 'Exported' }),
    );
    statusDropdown.value = statusFilter;

    const toolbar = h('div', { class: 'toolbar' },
      h('div', { class: 'search-inline' },
        icon('search'),
        searchInput),
      statusDropdown,
      h('div', { class: 'toolbar-spacer' }),
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: async () => {
          await loadStats();
          await loadReports();
          render();
          toast('Reports refreshed', 'info');
        },
      }, icon('retry'), 'Refresh'));

    wrapper.appendChild(toolbar);

    if (reports.length === 0) {
      wrapper.appendChild(
        h('div', { class: 'empty' },
          h('div', { class: 'empty-art' }, icon('document')),
          h('h2', { text: searchTerm || statusFilter !== 'all' ? 'No matching reports' : 'No Feedback Reports Saved' }),
          h('p', { text: 'Use the "Report a Bug" or "Suggest a Feature" tabs above to log your first report.' }),
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            onclick: () => {
              activeTab = 'bug';
              render();
            },
          }, icon('plus'), 'Create Bug Report')),
      );
      return wrapper;
    }

    // Reports Table
    const tbody = h('tbody');
    for (const r of reports) {
      const typeBadge = h('span', {
        class: `badge ${r.report_type === 'bug' ? 'badge-warn' : 'badge-accent'}`,
        text: r.report_type.toUpperCase(),
      });

      const statusBadge = h('span', {
        class: `badge ${r.status === 'ready' ? 'badge-accent' : r.status === 'draft' ? 'badge-subtle' : ''}`,
        text: r.status,
      });

      const exportBadge = (r.is_exported || r.exported_at)
        ? h('span', { class: 'badge badge-accent', title: `Exported ${r.exported_at ? new Date(r.exported_at).toLocaleString() : ''}`, text: 'Exported' })
        : null;

      const severityBadge = r.severity ? h('span', {
        class: `badge ${r.severity === 'critical' || r.severity === 'high' ? 'badge-danger' : ''}`,
        text: r.severity,
      }) : h('span', { class: 'text-dim', text: '—' });

      const tr = h('tr', {},
        h('td', { class: 'num' }, h('strong', { text: r.report_id })),
        h('td', {}, typeBadge),
        h('td', { class: 'col-name' }, h('span', { text: r.title, title: r.title })),
        h('td', {}, h('span', { class: 'cat-chip', text: r.category.replace(/_/g, ' ') })),
        h('td', {}, severityBadge),
        h('td', {}, statusBadge, exportBadge ? ' ' : '', exportBadge || ''),
        h('td', {}, h('span', { text: relativeTime(r.created_at), title: new Date(r.created_at).toLocaleString() })),
        h('td', { class: 'row-actions' },
          h('button', {
            class: 'btn btn-sm btn-icon-subtle',
            type: 'button',
            title: 'View & Edit Report',
            onclick: () => showEditReportModal(ctx, r, async () => {
              await loadStats();
              await loadReports();
              render();
            }),
          }, icon('file')),
          h('button', {
            class: 'btn btn-sm btn-icon-subtle',
            type: 'button',
            title: 'Export as JSON',
            onclick: async () => {
              const res = await guard(ctx.api.feedback.exportJson({ id: r.id }));
              if (res && !res.canceled && res.path) {
                toast(`Exported ${r.report_id}.json`, 'ok');
                await loadStats();
                await loadReports();
                render();
              }
            },
          }, icon('document')),
          h('button', {
            class: 'btn btn-sm btn-icon-subtle',
            type: 'button',
            title: 'Export full ZIP with diagnostics',
            onclick: async () => {
              const res = await guard(ctx.api.feedback.exportZip({ id: r.id }));
              if (res && !res.canceled && res.path) {
                toast(`Exported ${r.report_id} ZIP bundle`, 'ok');
                await loadStats();
                await loadReports();
                render();
              }
            },
          }, icon('export')),
          h('button', {
            class: 'btn btn-sm btn-icon-subtle btn-danger-hover',
            type: 'button',
            title: 'Delete Report',
            onclick: async () => {
              const confirmed = await confirmDialog({
                title: 'Delete Feedback Report?',
                message: `Are you sure you want to delete report ${r.report_id} ("${r.title}")? This action cannot be undone.`,
                confirmLabel: 'Delete Report',
                danger: true,
              });
              if (confirmed) {
                await guard(ctx.api.feedback.delete(r.id));
                toast('Report deleted', 'ok');
                await loadStats();
                await loadReports();
                render();
              }
            },
          }, icon('trash')),
        ),
      );

      tbody.appendChild(tr);
    }

    const tableWrap = h('div', { class: 'table-wrap card' },
      h('table', { class: 'dl' },
        h('thead', {},
          h('tr', {},
            h('th', { class: 'num', text: 'Report ID' }),
            h('th', { text: 'Type' }),
            h('th', { text: 'Title' }),
            h('th', { text: 'Category' }),
            h('th', { text: 'Severity' }),
            h('th', { text: 'Status' }),
            h('th', { text: 'Created' }),
            h('th', { text: 'Actions' }),
          )),
        tbody));

    wrapper.appendChild(tableWrap);
    return wrapper;
  }

  // ---------------------------------------------------------------------------
  // TAB 4: TROUBLESHOOTING & SUPPORT CENTER
  // ---------------------------------------------------------------------------
  function renderTroubleshooting() {
    const wrapper = h('div', { class: 'troubleshoot-container' });

    const guides = [
      {
        id: 'guide-403',
        title: 'Downloads Failing with HTTP 403 Forbidden or 404 Not Found',
        icon: 'alert',
        cause: 'Direct links frequently expire, employ hotlink session tokens, or require browser authorization cookies.',
        solutions: [
          'Copy a fresh direct download link from your browser and start immediately.',
          'Verify that the URL begins with http:// or https:// and is publicly accessible.',
          'If downloading from a gated file host, initiate the download through the BARQ Chrome or Edge Extension so session headers are passed.',
        ],
      },
      {
        id: 'guide-speed',
        title: 'Slow Download Speed or ISP Throttling',
        icon: 'speed',
        cause: 'Remote web servers may restrict individual HTTP TCP stream bandwidth to 500 KB/s - 2 MB/s.',
        solutions: [
          'Enable parallel acceleration: go to Settings → Multi-Segment Engine and increase Parallel Connections to 8 or 16.',
          'Ensure the Global Speed Limit in Settings is set to 0 (unlimited).',
          'Verify your network adapter is not on a metered or VPN connection that throttles large file transfers.',
        ],
      },
      {
        id: 'guide-pause',
        title: 'Download Restarts from Byte 0 Instead of Resuming',
        icon: 'retry',
        cause: 'The server either does not support HTTP Range requests (HTTP 206) or changed its content ETag header.',
        solutions: [
          'Inspect download details: look for "Range Support: Supported". If unsupported, servers ignore byte offsets and stream from start.',
          'BARQ safeguards against corrupted files by resetting from byte 0 when an ETag mismatch is detected.',
          'Avoid pausing dynamic streaming media or single-use download links that invalidate partial chunks.',
        ],
      },
      {
        id: 'guide-extension',
        title: 'Chrome / Edge Extension Says "Extension: Offline"',
        icon: 'browser',
        cause: 'The Native Messaging Host registry entry may not be registered or the background pipe is restarting.',
        solutions: [
          'Open Settings → Browser Integration and click "Register Native Host".',
          'Restart your browser or reload the BARQ extension in chrome://extensions.',
          'Ensure BARQ Downloader is running before triggering right-click "Download with BARQ".',
        ],
      },
      {
        id: 'guide-antivirus',
        title: 'File Merging Stalls or Access Denied on Completed Downloads',
        icon: 'shield',
        cause: 'Windows Defender or antivirus scanners may lock partial .barq-part chunks while assembling large files.',
        solutions: [
          'Ensure the destination drive has at least double the target file size in free disk space.',
          'If your antivirus scans newly assembled files intensely, whitelist your BARQ Downloads directory.',
          'Verify that you have Windows write permissions to the destination folder.',
        ],
      },
    ];

    const guidesGrid = h('div', { class: 'troubleshoot-grid' },
      ...guides.map((g) => {
        return h('div', { class: 'card troubleshoot-card' },
          h('div', { class: 'troubleshoot-head' },
            icon(g.icon, 'troubleshoot-icon'),
            h('h3', { text: g.title })),
          h('div', { class: 'troubleshoot-cause' },
            h('strong', { text: 'Common Cause: ' }),
            h('span', { text: g.cause })),
          h('ul', { class: 'troubleshoot-steps' },
            ...g.solutions.map((s) => h('li', { text: s }))),
        );
      }),
    );

    wrapper.append(
      h('div', { class: 'troubleshoot-intro' },
        h('h2', { text: 'Self-Service Diagnostic & Troubleshooting Guides' }),
        h('p', { class: 'section-sub', text: 'Actionable solutions for the most common Windows networking and downloading challenges.' })),
      guidesGrid,
    );

    return wrapper;
  }

  // Initial render
  Promise.all([loadStats(), loadReports()]).then(() => {
    if (!disposed) render();
  });

  return {
    refresh: async () => {
      await loadStats();
      if (activeTab === 'reports') await loadReports();
      render();
    },
    dispose: () => {
      disposed = true;
    },
  };
}

// -----------------------------------------------------------------------------
// MODALS: DIAGNOSTIC PREVIEW & REPORT EDIT
// -----------------------------------------------------------------------------

function showDiagnosticPreviewModal(ctx) {
  return openModal((close) => {
    const previewContainer = h('div', { class: 'diag-preview-wrap' },
      h('p', { class: 'diag-loading', text: 'Collecting and sanitizing system diagnostics...' }));

    ctx.api.feedback.getDiagnosticPreview().then((bundle) => {
      clear(previewContainer);

      const jsonStr = JSON.stringify(bundle, null, 2);

      const notice = h('div', { class: 'diag-notice-box' },
        icon('shield'),
        h('div', {},
          h('strong', { text: 'Privacy Verified — Zero Personal Data Leaks' }),
          h('p', { text: 'All URLs, download destinations, system usernames, passwords, and tokens have been automatically redacted. You maintain complete control over this data.' })));

      const codeBlock = h('pre', { class: 'diag-code-view' },
        h('code', { text: jsonStr }));

      previewContainer.append(notice, codeBlock);
    }).catch((err) => {
      clear(previewContainer);
      previewContainer.appendChild(h('div', { class: 'notice notice-error', text: `Failed to collect diagnostics: ${err.message}` }));
    });

    const copyBtn = h('button', {
      class: 'btn btn-secondary',
      type: 'button',
      onclick: async () => {
        try {
          const bundle = await ctx.api.feedback.getDiagnosticPreview();
          await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
          toast('Sanitized diagnostics copied to clipboard', 'ok');
        } catch {
          toast('Failed to copy diagnostics', 'error');
        }
      },
    }, icon('copy'), 'Copy to Clipboard');

    const exportBtn = h('button', {
      class: 'btn btn-primary',
      type: 'button',
      onclick: async () => {
        const res = await guard(ctx.api.feedback.exportJson({ includeDiagnostics: true }));
        if (res && !res.canceled && res.path) {
          toast(`Saved diagnostic report to ${res.path}`, 'ok');
          close(true);
        }
      },
    }, icon('export'), 'Export JSON');

    const closeBtn = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => close(false),
    }, 'Close');

    return {
      title: 'BARQ System Diagnostics Preview',
      body: [previewContainer],
      actions: [copyBtn, exportBtn, closeBtn],
      initialFocus: closeBtn,
    };
  });
}

function showEditReportModal(ctx, report, onSaved) {
  return openModal((close) => {
    const titleInput = h('input', {
      class: 'input input-wide',
      type: 'text',
      value: report.title || '',
      maxlength: 200,
    });

    const descTextarea = h('textarea', {
      class: 'input textarea-tall',
      rows: 4,
    });
    descTextarea.value = report.description || '';

    const reproTextarea = h('textarea', {
      class: 'input textarea-medium',
      rows: 3,
    });
    reproTextarea.value = report.reproduction_steps || '';

    const expectedTextarea = h('textarea', {
      class: 'input textarea-medium',
      rows: 2,
    });
    expectedTextarea.value = report.expected_behavior || '';

    const actualTextarea = h('textarea', {
      class: 'input textarea-medium',
      rows: 2,
    });
    actualTextarea.value = report.actual_behavior || '';

    const statusSelect = h('select', { class: 'input' },
      h('option', { value: 'draft', text: 'Draft' }),
      h('option', { value: 'saved', text: 'Saved' }),
      h('option', { value: 'exported', text: 'Exported' }),
      h('option', { value: 'ready', text: 'Ready' }),
    );
    statusSelect.value = report.status || 'saved';

    const saveBtn = h('button', {
      class: 'btn btn-primary',
      type: 'button',
      onclick: async () => {
        const patch = {
          id: report.id,
          title: titleInput.value.trim(),
          description: descTextarea.value.trim(),
          reproduction_steps: reproTextarea.value.trim() || null,
          expected_behavior: expectedTextarea.value.trim() || null,
          actual_behavior: actualTextarea.value.trim() || null,
          status: statusSelect.value,
        };
        const updated = await guard(ctx.api.feedback.save(patch));
        if (updated) {
          toast(`Updated report #${report.report_id}`, 'ok');
          if (onSaved) await onSaved();
          close(true);
        }
      },
    }, icon('check'), 'Save Changes');

    const cancelBtn = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => close(false),
    }, 'Cancel');

    const bodyNodes = [
      h('div', { class: 'modal-meta-row' },
        h('span', { class: 'badge badge-accent', text: report.report_id }),
        h('span', { class: 'badge', text: report.report_type.toUpperCase() }),
        h('span', { class: 'text-dim', text: `Created ${new Date(report.created_at).toLocaleString()}` })),
      h('div', { class: 'form-group' },
        h('label', { class: 'form-label', text: 'Title' }),
        titleInput),
      h('div', { class: 'form-group' },
        h('label', { class: 'form-label', text: 'Status' }),
        statusSelect),
      h('div', { class: 'form-group' },
        h('label', { class: 'form-label', text: 'Description' }),
        descTextarea),
    ];

    if (report.report_type === 'bug') {
      bodyNodes.push(
        h('div', { class: 'form-group' },
          h('label', { class: 'form-label', text: 'Reproduction Steps' }),
          reproTextarea),
        h('div', { class: 'form-row' },
          h('div', { class: 'form-col' },
            h('label', { class: 'form-label', text: 'Expected' }),
            expectedTextarea),
          h('div', { class: 'form-col' },
            h('label', { class: 'form-label', text: 'Actual' }),
            actualTextarea)),
      );
    }

    return {
      title: `Feedback Report — ${report.report_id}`,
      body: bodyNodes,
      actions: [cancelBtn, saveBtn],
      initialFocus: titleInput,
    };
  });
}
