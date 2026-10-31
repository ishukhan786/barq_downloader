'use strict';

/**
 * BARQ Downloader — Chrome/Edge Service Worker
 * Handles context menus, Native Messaging dispatch, and popup coordination.
 */

const NATIVE_HOST_NAME = 'com.barq.downloader';
const PROTOCOL_VERSION = 1;

function generateRequestId() {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isValidHttpUrl(string) {
  try {
    const url = new URL(string.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// 1. Context Menus Registration
// -----------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  // Remove existing menu items to prevent duplicate errors
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'barq-download-context',
      title: 'Download with BARQ',
      contexts: ['link', 'image', 'selection'],
    });
  });
});

// -----------------------------------------------------------------------------
// 2. Context Menu Click Handler
// -----------------------------------------------------------------------------
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'barq-download-context') return;

  let targetUrl = null;
  let filenameHint = null;

  if (info.linkUrl) {
    targetUrl = info.linkUrl;
  } else if (info.srcUrl) {
    targetUrl = info.srcUrl;
    // Derive filename hint from image URL path
    try {
      const u = new URL(targetUrl);
      filenameHint = u.pathname.split('/').pop() || null;
    } catch {}
  } else if (info.selectionText && isValidHttpUrl(info.selectionText)) {
    targetUrl = info.selectionText.trim();
  }

  if (!targetUrl || !isValidHttpUrl(targetUrl)) {
    showBadge('!', '#EF4444');
    return;
  }

  const requestId = generateRequestId();
  const request = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    operation: 'submit_download',
    payload: {
      url: targetUrl,
      source: 'context_menu',
      filenameHint,
    },
  };

  chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, request, (response) => {
    const err = chrome.runtime.lastError;
    if (err || !response || !response.ok) {
      console.warn('BARQ Downloader native messaging error:', err || response?.message);
      showBadge('!', '#EF4444');
    } else {
      showBadge('✓', '#10B981');
    }
  });
});

function showBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
  }, 3000);
}

// -----------------------------------------------------------------------------
// 3. Message Routing for Toolbar Popup
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'get_status') {
    const requestId = generateRequestId();
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { protocolVersion: PROTOCOL_VERSION, requestId, operation: 'get_status' },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          sendResponse({
            protocolVersion: PROTOCOL_VERSION,
            requestId,
            ok: false,
            status: 'unavailable',
            code: 'NATIVE_HOST_UNAVAILABLE',
            message: err.message || 'BARQ Native Host is not registered.',
          });
        } else {
          sendResponse(response);
        }
      }
    );
    return true; // Keep message channel open for async response
  }

  if (message.action === 'submit_url') {
    const requestId = generateRequestId();
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        operation: 'submit_download',
        payload: {
          url: message.url,
          source: 'toolbar_popup',
          filenameHint: message.filenameHint || null,
        },
      },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          sendResponse({
            protocolVersion: PROTOCOL_VERSION,
            requestId,
            ok: false,
            status: 'unavailable',
            code: 'NATIVE_HOST_UNAVAILABLE',
            message: err.message || 'BARQ Native Host is not registered.',
          });
        } else {
          sendResponse(response);
        }
      }
    );
    return true; // Keep message channel open for async response
  }
});
