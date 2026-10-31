// Add Download dialog: URL, filename probe, destination selection, and queuing
import { h, icon } from '../dom.js';
import { formatBytes } from '../format.js';
import { openModal, toast, guard } from '../ui.js';

export async function showAddDownloadDialog(ctx) {
  let settings = {};
  try {
    settings = await ctx.api.settings.get();
  } catch {}

  let destination = settings.downloadDir || '';
  let probedInfo = null;

  return openModal((close) => {
    const urlInput = h('input', {
      class: 'input input-wide',
      type: 'url',
      placeholder: 'https://example.com/file.zip',
      autocomplete: 'off',
      spellcheck: 'false',
    });

    const filenameInput = h('input', {
      class: 'input input-wide',
      type: 'text',
      placeholder: 'Filename (auto-detected from URL or server)',
      autocomplete: 'off',
      spellcheck: 'false',
    });

    const destDisplay = h('div', { class: 'path-display', text: destination || 'Default download folder' });

    const destBtn = h('button', {
      class: 'btn btn-sm',
      type: 'button',
      onclick: async () => {
        const res = await guard(ctx.api.downloads.chooseDestination());
        if (res && !res.canceled && res.path) {
          destination = res.path;
          destDisplay.textContent = destination;
        }
      },
    }, icon('folder'), 'Browse…');

    const hint = h('div', { class: 'field-hint', text: 'Enter an http:// or https:// direct download link.' });
    const infoBanner = h('div', { class: 'notice hidden' });

    let debounceTimer = null;

    async function checkAndProbe() {
      const val = urlInput.value.trim();
      if (!val) {
        hint.className = 'field-hint';
        hint.textContent = 'Enter an http:// or https:// direct download link.';
        infoBanner.classList.add('hidden');
        return null;
      }

      hint.className = 'field-hint';
      hint.textContent = 'Verifying URL and inspecting remote file...';

      try {
        const valRes = await ctx.api.downloads.validateUrl(val);
        if (!valRes.ok) {
          hint.className = 'field-hint error';
          hint.textContent = valRes.error;
          infoBanner.classList.add('hidden');
          return null;
        }

        hint.className = 'field-hint ok';
        hint.textContent = 'Valid download link.';

        // Attempt probe in background
        ctx.api.downloads.probe(valRes.url).then((probe) => {
          probedInfo = probe;
          if (probe.filename && (!filenameInput.value || filenameInput.dataset.auto === '1')) {
            filenameInput.value = probe.filename;
            filenameInput.dataset.auto = '1';
          }

          infoBanner.classList.remove('hidden');
          infoBanner.replaceChildren(
            icon('info'),
            h('span', {
              text: `Size: ${formatBytes(probe.totalBytes)} | MIME: ${probe.mimeType || 'unknown'} | Ranges: ${probe.supportsRanges ? 'Supported (Resume enabled)' : 'Not advertised'}`,
            })
          );
        }).catch(() => {
          // Probe failure is non-fatal: fallback to URL filename
          const uParts = valRes.url.split('/').pop().split('?')[0];
          if (!filenameInput.value && uParts) {
            filenameInput.value = decodeURIComponent(uParts);
            filenameInput.dataset.auto = '1';
          }
        });

        return valRes.url;
      } catch (err) {
        hint.className = 'field-hint error';
        hint.textContent = err.message;
        infoBanner.classList.add('hidden');
        return null;
      }
    }

    urlInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkAndProbe, 400);
    });

    urlInput.addEventListener('blur', checkAndProbe);

    filenameInput.addEventListener('input', () => {
      filenameInput.dataset.auto = '0';
    });

    const cancelBtn = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => close(),
    }, 'Cancel');

    async function submit(startNow) {
      const validUrl = await checkAndProbe();
      if (!validUrl) {
        urlInput.setAttribute('aria-invalid', 'true');
        urlInput.focus();
        return;
      }

      const fn = filenameInput.value.trim() || (probedInfo ? probedInfo.filename : null);
      try {
        const record = await ctx.api.downloads.add({
          url: validUrl,
          filename: fn,
          destination: destination || undefined,
          startNow,
        });

        toast(`Added "${record.filename}" (${startNow ? 'Downloading' : 'Queued'})`, 'ok');
        close(record);
        if (ctx.refreshStats) ctx.refreshStats();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const queueBtn = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => submit(false),
    }, icon('queue'), 'Add to Queue');

    const downloadNowBtn = h('button', {
      class: 'btn btn-primary',
      type: 'button',
      onclick: () => submit(true),
    }, icon('bolt'), 'Download Now');

    return {
      title: 'Add Download',
      body: [
        h('div', { class: 'field' },
          h('label', { for: 'download-url', text: 'Download URL' }),
          urlInput,
          hint),
        h('div', { class: 'field' },
          h('label', { for: 'download-filename', text: 'Filename' }),
          filenameInput),
        h('div', { class: 'field' },
          h('label', { text: 'Save To' }),
          h('div', { class: 'setting-control' },
            destDisplay,
            destBtn)),
        infoBanner,
      ],
      actions: [cancelBtn, queueBtn, downloadNowBtn],
      initialFocus: urlInput,
    };
  });
}
