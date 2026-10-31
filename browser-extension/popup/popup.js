'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const statusPill = document.getElementById('status-pill');
  const statusText = document.getElementById('status-text');
  const urlInput = document.getElementById('url-input');
  const filenameInput = document.getElementById('filename-input');
  const btnDownload = document.getElementById('btn-download');
  const btnRetry = document.getElementById('btn-retry');
  const feedback = document.getElementById('feedback');
  const setupHint = document.getElementById('setup-hint');

  let isConnected = false;

  function setStatus(status, text) {
    statusPill.className = `status-pill status-${status}`;
    statusText.textContent = text;
    isConnected = status === 'connected';

    if (isConnected) {
      btnRetry.classList.add('hidden');
      setupHint.classList.add('hidden');
      validateForm();
    } else {
      btnRetry.classList.remove('hidden');
      setupHint.classList.remove('hidden');
      btnDownload.disabled = true;
    }
  }

  function showFeedback(text, type = 'success') {
    feedback.className = `feedback feedback-${type}`;
    feedback.textContent = text;
    feedback.classList.remove('hidden');
  }

  function hideFeedback() {
    feedback.classList.add('hidden');
  }

  function validateForm() {
    const raw = (urlInput.value || '').trim();
    const hasValidUrl = raw.startsWith('http://') || raw.startsWith('https://');
    btnDownload.disabled = !isConnected || !hasValidUrl;
  }

  urlInput.addEventListener('input', validateForm);

  // 1. Fetch current active tab URL
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
      urlInput.value = tab.url;
      try {
        const u = new URL(tab.url);
        const name = u.pathname.split('/').pop();
        if (name && name.includes('.')) {
          filenameInput.value = decodeURIComponent(name);
        }
      } catch {}
    }
  } catch {}

  // 2. Check BARQ Desktop connection
  async function checkConnection() {
    setStatus('checking', 'Connecting...');
    hideFeedback();

    chrome.runtime.sendMessage({ action: 'get_status' }, (response) => {
      const err = chrome.runtime.lastError;
      if (err || !response || !response.ok) {
        setStatus('disconnected', 'Disconnected');
        if (response?.code === 'BARQ_NOT_RUNNING') {
          showFeedback('BARQ Downloader app is not running. Please open BARQ.', 'error');
        } else {
          showFeedback(response?.message || 'Native Messaging Host not reachable.', 'error');
        }
      } else {
        setStatus('connected', 'Connected');
        validateForm();
      }
    });
  }

  btnRetry.addEventListener('click', () => {
    checkConnection();
  });

  // 3. Handle Submit
  btnDownload.addEventListener('click', async () => {
    const rawUrl = urlInput.value.trim();
    const rawHint = filenameInput.value.trim();

    if (!rawUrl) return;

    btnDownload.disabled = true;
    btnDownload.textContent = 'Adding to BARQ...';
    hideFeedback();

    chrome.runtime.sendMessage(
      {
        action: 'submit_url',
        url: rawUrl,
        filenameHint: rawHint || null,
      },
      (response) => {
        btnDownload.textContent = 'Download with BARQ';
        validateForm();

        const err = chrome.runtime.lastError;
        if (err || !response || !response.ok) {
          showFeedback(response?.message || 'Failed to submit download to BARQ.', 'error');
        } else {
          showFeedback(`✓ Download accepted by BARQ (#${response.downloadId})`, 'success');
          setTimeout(() => {
            window.close(); // Close popup smoothly after successful addition
          }, 1800);
        }
      }
    );
  });

  // Initial connection check on popup open
  await checkConnection();
});
