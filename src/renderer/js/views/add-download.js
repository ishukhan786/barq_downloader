// Add Download dialog: URL input, schema validation, and queuing
import { h, icon } from '../dom.js';
import { openModal, toast } from '../ui.js';

export function showAddDownloadDialog(ctx) {
  openModal((close) => {
    let validating = false;

    const urlInput = h('input', {
      class: 'input input-wide',
      type: 'url',
      placeholder: 'https://example.com/file.zip',
      autocomplete: 'off',
      spellcheck: 'false',
    });

    const hint = h('div', { class: 'field-hint', text: 'Enter an http:// or https:// direct download link.' });

    const notice = h('div', { class: 'notice' },
      icon('info'),
      h('span', { text: 'Engine foundation: In Milestone 1, URL syntax and schemes are strictly validated. Active HTTP downloading arrives in Milestone 2.' }));

    async function checkUrl() {
      const val = urlInput.value.trim();
      if (!val) {
        hint.className = 'field-hint';
        hint.textContent = 'Enter an http:// or https:// direct download link.';
        return null;
      }
      validating = true;
      try {
        const res = await ctx.api.downloads.validateUrl(val);
        if (res.ok) {
          hint.className = 'field-hint ok';
          hint.textContent = 'Valid download link URL.';
          return res.url;
        } else {
          hint.className = 'field-hint error';
          hint.textContent = res.error;
          return null;
        }
      } catch (err) {
        hint.className = 'field-hint error';
        hint.textContent = err.message;
        return null;
      } finally {
        validating = false;
      }
    }

    urlInput.addEventListener('input', () => {
      checkUrl();
    });

    const cancelBtn = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => close(),
    }, 'Cancel');

    const submitBtn = h('button', {
      class: 'btn btn-primary',
      type: 'button',
      onclick: async () => {
        const valid = await checkUrl();
        if (!valid) {
          urlInput.setAttribute('aria-invalid', 'true');
          urlInput.focus();
          return;
        }
        toast('URL verified. Direct download engine begins in Milestone 2.', 'info');
        close({ url: valid });
      },
    }, icon('plus'), 'Start Download');

    return {
      title: 'Add New Download',
      body: [
        h('div', { class: 'field' },
          h('label', { for: 'download-url', text: 'Download URL' }),
          urlInput,
          hint),
        notice,
      ],
      actions: [cancelBtn, submitBtn],
      initialFocus: urlInput,
    };
  });
}
