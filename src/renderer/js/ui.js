// Shared UI primitives: toasts, modal, confirmation dialog.
import { h, clear, icon, $ } from './dom.js';

export function toast(message, kind = 'info', ms = 3500) {
  const region = $('#toasts');
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info'),
    h('span', { text: message }));
  region.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/**
 * Opens the shared <dialog>. `build(close)` returns { title, body: Node[], actions: Node[] }.
 * Resolves with the value passed to close().
 */
export function openModal(build) {
  const dlg = $('#modal');
  return new Promise((resolve) => {
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      dlg.close();
      resolve(value);
    };
    const { title, body = [], actions = [], initialFocus } = build(close);
    clear(dlg);
    dlg.append(
      h('div', { class: 'modal-head' }, h('h2', { id: 'modal-title', text: title })),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' }, actions),
    );
    dlg.addEventListener('close', () => close(undefined), { once: true });
    dlg.showModal();
    if (initialFocus) initialFocus.focus();
  });
}

/** Accessible confirmation dialog. Resolves true only on explicit confirmation. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return openModal((close) => {
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel');
    const ok = h('button', { class: `btn ${danger ? 'btn-danger btn-solid' : 'btn-primary'}`, type: 'button', onclick: () => close(true) }, confirmLabel);
    return { title, body: [h('p', { text: message })], actions: [cancel, ok], initialFocus: cancel };
  }).then((v) => v === true);
}

export async function guard(promise, okMessage) {
  try {
    const r = await promise;
    if (okMessage) toast(okMessage, 'ok');
    return r;
  } catch (err) {
    toast(err.message || String(err), 'error', 6000);
    return undefined;
  }
}
