/**
 * offscreen.js - 24/7 Offscreen Background Engine & Audio Synthesizer
 * 
 * Runs continuously in a full window/DOM context to provide audio synthesis
 * and keep background polling ticking every 15 seconds.
 */

import { parseJobsFromHTML } from './parser.js';
import { playNotificationSound } from './sound.js';

// ============================================================================
// 1. Continuous Timer Heartbeat
// ============================================================================
let timerHandle = null;

async function setupTimer() {
  if (timerHandle) clearInterval(timerHandle);

  const sync = await chrome.storage.sync.get(['pollIntervalSeconds']);
  const sec = Math.max(5, Number(sync.pollIntervalSeconds) || 15);

  console.log(`[Offscreen Engine] Background timer ticking every ${sec}s.`);

  timerHandle = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'OFFSCREEN_POLL_TICK' }, () => {
      if (chrome.runtime.lastError) {
        // Suppress expected transient warnings during worker cycle
      }
    });
  }, sec * 1000);
}

// React to interval changes in settings
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.pollIntervalSeconds) {
    setupTimer();
  }
});

// Start timer immediately
setupTimer();

// ============================================================================
// 2. Message Listeners
// ============================================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'PARSE_HTML') {
    try {
      const { html } = message;
      const jobs = parseJobsFromHTML(html, DOMParser);
      sendResponse({ success: true, jobs });
    } catch (error) {
      console.error('[Offscreen Parser Error]:', error);
      sendResponse({ success: false, error: error.message, jobs: [] });
    }
    return true;
  }

  if (message?.action === 'PLAY_SOUND') {
    playNotificationSound()
      .then((success) => {
        sendResponse({ success });
      })
      .catch((err) => {
        console.error('[Offscreen Sound Error]:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message?.action === 'RESTART_OFFSCREEN_TIMER') {
    setupTimer();
    sendResponse({ success: true });
    return true;
  }
});
