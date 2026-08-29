/**
 * popup.js - Extension Popup UI Controller
 * 
 * Provides interactive settings, keyword filtering configuration,
 * frequency interval controls, sound alerts, manual poll triggers, and live diagnostics.
 */

import { playNotificationSound } from './sound.js';

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const keywordInput = document.getElementById('keywordInput');
  const intervalSelect = document.getElementById('intervalSelect');
  const pauseToggle = document.getElementById('pauseToggle');
  const soundToggle = document.getElementById('soundToggle');
  const toggleDescription = document.getElementById('toggleDescription');
  const statusBadge = document.getElementById('statusBadge');
  const checkNowBtn = document.getElementById('checkNowBtn');
  const testNotifyBtn = document.getElementById('testNotifyBtn');
  const lastCheckVal = document.getElementById('lastCheckVal');
  const seenCountVal = document.getElementById('seenCountVal');
  const errorBanner = document.getElementById('errorBanner');
  const toast = document.getElementById('toast');

  let toastTimeout = null;

  function showToast(message) {
    if (toastTimeout) clearTimeout(toastTimeout);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  function formatTime(timestamp) {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function updateStatusUI(isPaused, intervalSec) {
    if (isPaused) {
      statusBadge.textContent = 'Paused';
      statusBadge.classList.add('paused');
      toggleDescription.textContent = 'Monitoring is paused';
    } else {
      statusBadge.textContent = 'Active';
      statusBadge.classList.remove('paused');
      const sec = intervalSec || intervalSelect.value || 15;
      toggleDescription.textContent = sec < 60 ? `Auto-checking every ${sec}s` : `Auto-checking every ${Math.round(sec / 60)}m`;
    }
  }

  async function refreshStats() {
    try {
      const localData = await chrome.storage.local.get(['seenJobIds', 'lastCheckTime', 'lastError']);
      seenCountVal.textContent = (localData.seenJobIds || []).length;
      lastCheckVal.textContent = formatTime(localData.lastCheckTime);

      if (localData.lastError) {
        errorBanner.textContent = `⚠️ ${localData.lastError}`;
        errorBanner.style.display = 'block';
      } else {
        errorBanner.style.display = 'none';
      }
    } catch (err) {
      console.warn('Failed to refresh stats:', err);
    }
  }

  // 1. Initial Load from storage
  try {
    const syncData = await chrome.storage.sync.get(['keywords', 'isPaused', 'soundEnabled', 'pollIntervalSeconds']);
    if (syncData.keywords !== undefined) {
      keywordInput.value = syncData.keywords;
    }

    const interval = syncData.pollIntervalSeconds || 15;
    intervalSelect.value = String(interval);

    const isPaused = syncData.isPaused || false;
    pauseToggle.checked = !isPaused;
    updateStatusUI(isPaused, interval);

    const soundEnabled = syncData.soundEnabled !== false;
    soundToggle.checked = soundEnabled;

    await refreshStats();
  } catch (err) {
    console.error('Failed to load initial settings:', err);
  }

  // 2. Keyword Filter Input (Auto-save with debounce)
  let debounceTimer = null;
  keywordInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const keywords = keywordInput.value.trim();
      await chrome.storage.sync.set({ keywords });
      showToast('Filters updated');
    }, 400);
  });

  // 3. Polling Interval Select
  intervalSelect.addEventListener('change', async () => {
    const pollIntervalSeconds = Number(intervalSelect.value) || 30;
    await chrome.storage.sync.set({ pollIntervalSeconds });
    updateStatusUI(!pauseToggle.checked, pollIntervalSeconds);
    chrome.runtime.sendMessage({ action: 'RESTART_LOOP' });
    showToast(`Interval set to ${pollIntervalSeconds}s`);
  });

  // 4. Pause / Resume Toggle
  pauseToggle.addEventListener('change', async () => {
    const isPaused = !pauseToggle.checked;
    await chrome.storage.sync.set({ isPaused });
    updateStatusUI(isPaused, Number(intervalSelect.value));
    chrome.runtime.sendMessage({ action: 'RESTART_LOOP' });
    showToast(isPaused ? 'Monitoring paused' : 'Monitoring resumed');
  });

  // 5. Sound Alerts Toggle
  soundToggle.addEventListener('change', async () => {
    const soundEnabled = soundToggle.checked;
    await chrome.storage.sync.set({ soundEnabled });
    if (soundEnabled) {
      playNotificationSound().catch(() => {});
      showToast('Sound alerts enabled 🔊');
    } else {
      showToast('Sound alerts muted 🔇');
    }
  });

  // 6. "Check Mostaql Now" Button
  checkNowBtn.addEventListener('click', async () => {
    checkNowBtn.disabled = true;
    const btnText = document.getElementById('btnText');
    const originalText = btnText.textContent;
    btnText.textContent = 'Checking...';

    try {
      const response = await chrome.runtime.sendMessage({ action: 'CHECK_NOW' });
      if (response?.message) {
        showToast(response.message);
      } else {
        showToast('Check completed');
      }
    } catch (err) {
      console.warn('Check request sent:', err);
      showToast('Check triggered');
    } finally {
      await refreshStats();
      setTimeout(() => {
        checkNowBtn.disabled = false;
        btnText.textContent = originalText;
      }, 600);
    }
  });

  // 7. "Test Notification & Sound" Button
  testNotifyBtn.addEventListener('click', async () => {
    testNotifyBtn.disabled = true;
    try {
      if (soundToggle.checked) {
        playNotificationSound().catch((err) => console.warn('Popup audio error:', err));
      }
      const response = await chrome.runtime.sendMessage({ action: 'TEST_NOTIFICATION', skipSound: true });
      showToast(response?.message || 'Test alert sent!');
    } catch (err) {
      console.error('Failed to send test alert:', err);
      showToast('Alert triggered');
    } finally {
      setTimeout(() => {
        testNotifyBtn.disabled = false;
      }, 1000);
    }
  });

  // Auto refresh stats every 3 seconds while popup is open
  setInterval(refreshStats, 3000);
});
