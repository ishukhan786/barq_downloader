// About view: branding, environment details, licenses and credits
import { h, icon } from '../dom.js';

export function renderAbout(root, ctx) {
  const info = ctx.state.info;

  const aboutHero = h('div', { class: 'card about-hero' },
    h('img', { src: 'assets/brand/barq-logo.svg', alt: 'BARQ Downloader', width: 1120, height: 320 }));

  const appDetails = h('div', { class: 'card' },
    h('div', { class: 'card-header' },
      h('h2', { text: 'System & Architecture' })),
    h('dl', { class: 'kv' },
      h('dt', { text: 'Application' }),
      h('dd', { text: `${info.productName} (${info.productNameUrdu})` }),
      h('dt', { text: 'Version' }),
      h('dd', { text: info.version || '0.1.0' }),
      h('dt', { text: 'Identifier' }),
      h('dd', { text: info.appId }),
      h('dt', { text: 'Platform' }),
      h('dd', { text: `${info.platform} ${info.packaged ? '(Packaged)' : '(Development)'}` }),
      h('dt', { text: 'Electron' }),
      h('dd', { text: `v${info.electron}` }),
      h('dt', { text: 'Node.js' }),
      h('dd', { text: `v${info.node}` }),
      h('dt', { text: 'Chromium' }),
      h('dd', { text: `v${info.chrome}` }),
      h('dt', { text: 'SQLite' }),
      h('dd', { text: `v${info.sqlite || '3.x (Built-in Node.js)'}` }),
      h('dt', { text: 'Data Directory' }),
      h('dd', { class: 'mono', text: info.dataDir }),
      h('dt', { text: 'Data Storage Mode' }),
      h('dd', { text: `${info.dataMode} — ${info.dataReason}` }),
    ));

  const noticesCard = h('div', { class: 'card card-pad' },
    h('h2', { text: 'Independent Engineering & Integrity' }),
    h('p', { class: 'view-sub', text: 'BARQ Downloader is an independent, clean-room implementation built from scratch using Node.js, Electron, and SQLite. It does not use or copy any proprietary IDM code, assets, or trademarks.' }),
    h('div', { class: 'toolbar-gap' }),
    h('div', { class: 'toolbar' },
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: () => ctx.api.shell.openExternal('electron'),
      }, icon('external'), 'Electron Website'),
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: () => ctx.api.shell.openExternal('ytdlp'),
      }, icon('external'), 'yt-dlp Repository'),
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: () => ctx.api.shell.openExternal('ffmpeg'),
      }, icon('external'), 'FFmpeg Website')));

  root.append(
    h('div', { class: 'view-header' },
      h('div', {},
        h('h1', { text: 'About BARQ' }),
        h('p', { class: 'view-sub', text: 'Speed at Every Click. (برق ڈاؤنلوڈر)' }))),
    h('div', { class: 'about' },
      aboutHero,
      appDetails,
      noticesCard),
  );

  return {
    refresh() {},
    dispose() {},
  };
}
