/**
 * background.js - Main Service Worker for Mostaql Job Monitor
 * 
 * Runs automatically 24/7 in the background:
 * 1. Automatic periodic polling every 15 seconds using self-scheduling Chrome alarms + offscreen heartbeat.
 * 2. Fetches Mostaql latest projects safely with timeouts and wildcard permissions.
 * 3. Compares incoming projects against seen history.
 * 4. Dispatches instant rich desktop notifications with job details + custom MP3 alert sound.
 * 5. Opens the project URL in a new tab when clicked.
 */

import { normalizeArabicText, parseJobsFromHTML } from './parser.js';

const ALARM_AUTO_POLL = 'MOSTAQL_AUTO_POLL_ALARM';
const ALARM_WATCHDOG_NAME = 'MOSTAQL_WATCHDOG_ALARM';
const DEFAULT_INTERVAL_SECONDS = 15;
const MAX_SEEN_ITEMS = 200;
const MOSTAQL_PROJECTS_URL = 'https://mostaql.com/projects?sort=latest';
const MOSTAQL_FALLBACK_URL = 'https://mostaql.com/projects';

let isFetching = false;

// ============================================================================
// 1. Lifecycle & Persistent Scheduling
// ============================================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Mostaql Monitor] Extension installed/updated:', details.reason);
  
  const sync = await chrome.storage.sync.get(['keywords', 'isPaused', 'soundEnabled', 'pollIntervalSeconds']);
  const updates = {};
  if (sync.isPaused === undefined) updates.isPaused = false; // Auto monitoring ON by default
  if (sync.keywords === undefined) updates.keywords = '';
  if (sync.soundEnabled === undefined) updates.soundEnabled = true;
  if (sync.pollIntervalSeconds === undefined || sync.pollIntervalSeconds === 3) {
    updates.pollIntervalSeconds = DEFAULT_INTERVAL_SECONDS;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
  }

  const local = await chrome.storage.local.get(['seenJobIds']);
  if (!local.seenJobIds) {
    await chrome.storage.local.set({ seenJobIds: [], lastCheckTime: null, lastError: null });
  } else {
    await chrome.storage.local.set({ lastError: null });
  }

  await ensureOffscreenDocument();
  await setupWatchdogAlarm();
  await scheduleNextAutoPoll(2); // Start first automatic poll in 2 seconds
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Mostaql Monitor] Chrome startup.');
  await ensureOffscreenDocument();
  await setupWatchdogAlarm();
  await scheduleNextAutoPoll(3);
});

// Setup 1-minute fallback watchdog alarm
async function setupWatchdogAlarm() {
  await chrome.alarms.clear(ALARM_WATCHDOG_NAME);
  chrome.alarms.create(ALARM_WATCHDOG_NAME, { periodInMinutes: 1 });
}

/**
 * Schedules the next automatic poll with exact second precision
 */
export async function scheduleNextAutoPoll(overrideSeconds = null) {
  try {
    const sync = await chrome.storage.sync.get(['isPaused', 'pollIntervalSeconds']);
    if (sync.isPaused) {
      await chrome.alarms.clear(ALARM_AUTO_POLL);
      return;
    }

    const sec = overrideSeconds || Math.max(5, Number(sync.pollIntervalSeconds) || DEFAULT_INTERVAL_SECONDS);
    await chrome.alarms.clear(ALARM_AUTO_POLL);
    
    // Schedule alarm to fire in `sec` seconds
    chrome.alarms.create(ALARM_AUTO_POLL, {
      when: Date.now() + (sec * 1000)
    });
  } catch (err) {
    console.warn('[Mostaql Monitor] Scheduling notice:', err);
  }
}

// Alarm Event Listener
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_AUTO_POLL) {
    try {
      await ensureOffscreenDocument();
      await pollMostaql({ source: 'alarm_auto' });
    } finally {
      await scheduleNextAutoPoll(); // Automatically schedule the subsequent check
    }
  } else if (alarm.name === ALARM_WATCHDOG_NAME) {
    await ensureOffscreenDocument();
    // Watchdog check to ensure the cycle never dies
    const sync = await chrome.storage.sync.get(['isPaused']);
    if (!sync.isPaused) {
      const activeAlarm = await chrome.alarms.get(ALARM_AUTO_POLL);
      if (!activeAlarm) {
        await scheduleNextAutoPoll(1);
      }
    }
  }
});

// Watch for storage settings changes (pause/resume, interval changes)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync') {
    if (changes.isPaused || changes.pollIntervalSeconds) {
      scheduleNextAutoPoll(1);
    }
  }
});

// ============================================================================
// 2. Offscreen Document Manager (Audio & Secondary Heartbeat)
// ============================================================================

let creatingOffscreenPromise = null;

export async function ensureOffscreenDocument(forceRecreate = false) {
  const offscreenUrl = 'offscreen.html';

  if (!forceRecreate && chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
    try {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (hasDoc) return;
    } catch {}
  }

  if (forceRecreate && chrome.offscreen && typeof chrome.offscreen.closeDocument === 'function') {
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
  }

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: offscreenUrl,
    reasons: ['AUDIO_PLAYBACK', 'DOM_PARSER'],
    justification: 'Synthesize audio alerts and support continuous background monitoring'
  }).catch((err) => {
    if (!err.message?.includes('Only a single offscreen document')) {
      console.warn('[Mostaql Monitor] Offscreen creation note:', err.message);
    }
  }).finally(() => {
    creatingOffscreenPromise = null;
  });

  await creatingOffscreenPromise;
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function playSoundViaOffscreen() {
  try {
    await ensureOffscreenDocument();

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'PLAY_SOUND' }, (response) => {
        if (chrome.runtime.lastError) {
          ensureOffscreenDocument(true).then(() => {
            setTimeout(() => {
              chrome.runtime.sendMessage({ action: 'PLAY_SOUND' }, () => {
                resolve();
              });
            }, 100);
          });
        } else {
          resolve(response);
        }
      });
    });
  } catch (err) {
    console.warn('[Mostaql Monitor] Could not play alert sound:', err);
  }
}

// ============================================================================
// 3. Network Fetch with Timeout & Fallback
// ============================================================================

async function fetchMostaqlPage(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000); // 12-second timeout

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-cache',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} (${response.statusText || 'Error'})`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// 4. Robust Polling Engine
// ============================================================================

export async function pollMostaql(options = {}) {
  if (isFetching) {
    return { success: false, message: 'Check already in progress' };
  }
  isFetching = true;

  const source = options.source || 'auto';

  try {
    const syncSettings = await chrome.storage.sync.get(['keywords', 'isPaused', 'soundEnabled']);
    if (syncSettings.isPaused && source !== 'manual') {
      return { success: true, count: 0, message: 'Monitoring is paused' };
    }

    let html = '';
    try {
      html = await fetchMostaqlPage(MOSTAQL_PROJECTS_URL);
    } catch (primaryErr) {
      console.warn('[Mostaql Monitor] Primary URL fetch notice, trying fallback...', primaryErr.message);
      html = await fetchMostaqlPage(MOSTAQL_FALLBACK_URL);
    }

    if (!html || typeof html !== 'string') {
      throw new Error('Empty response received from Mostaql');
    }

    // Direct high-speed parsing
    const parsedJobs = parseJobsFromHTML(html);

    if (!parsedJobs || parsedJobs.length === 0) {
      await chrome.storage.local.set({ lastCheckTime: Date.now(), lastError: null });
      return { success: true, count: 0, message: 'No jobs found on page' };
    }

    // Retrieve seen history
    const localData = await chrome.storage.local.get(['seenJobIds']);
    const existingSeenIds = localData.seenJobIds || [];
    const seenSet = new Set(existingSeenIds);

    // Initial baseline setup (first run): store current items so user isn't spammed with 25 notifications
    if (existingSeenIds.length === 0) {
      const allCurrentIds = parsedJobs.map(j => j.id);
      await chrome.storage.local.set({
        seenJobIds: allCurrentIds.slice(0, MAX_SEEN_ITEMS),
        lastCheckTime: Date.now(),
        lastError: null
      });
      console.log(`[Mostaql Monitor] Initial baseline established with ${allCurrentIds.length} projects.`);
      return { success: true, count: 0, message: `Active: Auto-tracking ${allCurrentIds.length} projects` };
    }

    // Identify NEW jobs
    const newJobs = parsedJobs.filter((job) => !seenSet.has(job.id));

    const filterKeywords = (syncSettings.keywords || '')
      .split(',')
      .map((k) => normalizeArabicText(k.trim().toLowerCase()))
      .filter(Boolean);

    let notifiedCount = 0;
    const soundEnabled = syncSettings.soundEnabled !== false;

    if (newJobs.length > 0) {
      console.log(`[Mostaql Monitor] 🚨 FOUND ${newJobs.length} NEW JOB(S)!`, newJobs.map(j => j.title));

      for (const job of newJobs) {
        const isMatch = checkKeywordMatch(job, filterKeywords);
        
        if (isMatch) {
          await dispatchJobNotification(job, soundEnabled);
          notifiedCount++;
        }
      }
    }

    // Update seen history
    const updatedSeenList = Array.from(new Set([...parsedJobs.map(j => j.id), ...existingSeenIds])).slice(0, MAX_SEEN_ITEMS);

    await chrome.storage.local.set({
      seenJobIds: updatedSeenList,
      lastCheckTime: Date.now(),
      lastError: null // Clear previous errors on success
    });

    return {
      success: true,
      count: notifiedCount,
      totalParsed: parsedJobs.length,
      newFound: newJobs.length,
      message: newJobs.length > 0 ? `Found ${newJobs.length} NEW project(s)!` : 'Check complete: No new projects'
    };
  } catch (error) {
    let friendlyError = error.message;
    if (error.name === 'AbortError') {
      friendlyError = 'Request timed out (server took too long to respond)';
    } else if (friendlyError.includes('Failed to fetch')) {
      friendlyError = 'Network connection error or Mostaql is temporarily unreachable';
    }

    console.error('[Mostaql Monitor] Polling error:', friendlyError);
    await chrome.storage.local.set({
      lastCheckTime: Date.now(),
      lastError: friendlyError
    });
    return { success: false, count: 0, message: friendlyError };
  } finally {
    isFetching = false;
  }
}

// ============================================================================
// 5. Keyword Matching
// ============================================================================

function checkKeywordMatch(job, keywords) {
  if (!keywords || keywords.length === 0) {
    return true;
  }

  const searchableText = normalizeArabicText(
    `${job.title} ${job.category} ${job.description || ''}`.toLowerCase()
  );

  return keywords.some((keyword) => searchableText.includes(keyword));
}

// ============================================================================
// 6. Desktop Notification & Click Handling
// ============================================================================

async function dispatchJobNotification(job, playSound = true) {
  const notificationId = `mostaql_job_${job.id}___${encodeURIComponent(job.url)}`;
  const title = `🎯 ${job.title.slice(0, 65)}`;
  
  let description = (job.description || '').replace(/\s+/g, ' ').trim();
  if (description.length > 200) {
    description = description.slice(0, 197) + '...';
  }

  let messageLines = [];
  if (description) {
    messageLines.push(`📝 ${description}`);
  }

  let metaItems = [];
  if (job.budget && job.budget !== 'حسب الاتفاق') {
    metaItems.push(`💰 ${job.budget}`);
  }
  if (job.category && job.category !== 'مستقل') {
    metaItems.push(`📁 ${job.category}`);
  }

  if (metaItems.length > 0) {
    messageLines.push(metaItems.join('  •  '));
  }

  const message = messageLines.length > 0 ? messageLines.join('\n\n') : `مشروع جديد متاح على منصة مستقل`;
  const contextMessage = `مستقل • ${job.category || 'عام'} • ${job.postedTime || 'الآن'}`;
  const iconUrl = chrome.runtime.getURL('icons/icon-128.png');

  try {
    await chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl,
      title,
      message,
      contextMessage,
      priority: 2,
      requireInteraction: true,
      buttons: [
        { title: '🔗 فتح المشروع في مستقل' }
      ]
    });
  } catch (err) {
    try {
      await chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl,
        title,
        message,
        priority: 2
      });
    } catch (fallbackErr) {
      console.error('[Mostaql Monitor] Notification dispatch failed:', fallbackErr);
    }
  }

  if (playSound) {
    await playSoundViaOffscreen();
  }
  
  console.log(`[Mostaql Monitor] 🔔 Alert sent for #${job.id}: ${job.title}`);
}

// Handle notification body click
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId.startsWith('mostaql_job_')) {
    const parts = notificationId.split('___');
    if (parts.length > 1) {
      const targetUrl = decodeURIComponent(parts[1]);
      await chrome.tabs.create({ url: targetUrl });
      chrome.notifications.clear(notificationId);
    }
  }
});

// Handle notification button click
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (notificationId.startsWith('mostaql_job_')) {
    const parts = notificationId.split('___');
    if (parts.length > 1) {
      const targetUrl = decodeURIComponent(parts[1]);
      await chrome.tabs.create({ url: targetUrl });
      chrome.notifications.clear(notificationId);
    }
  }
});

// ============================================================================
// 7. Runtime Message Listener
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === 'OFFSCREEN_POLL_TICK') {
    pollMostaql({ source: 'offscreen_timer' });
    sendResponse({ received: true });
    return true;
  }

  if (request?.action === 'CHECK_NOW') {
    chrome.storage.local.set({ lastError: null }).then(() => {
      pollMostaql({ source: 'manual' }).then((result) => {
        sendResponse(result);
        scheduleNextAutoPoll(); // Continue automatic loop
      });
    });
    return true;
  }

  if (request?.action === 'RESTART_LOOP') {
    scheduleNextAutoPoll(1);
    chrome.runtime.sendMessage({ action: 'RESTART_OFFSCREEN_TIMER' }, () => {
      if (chrome.runtime.lastError) {}
    });
    sendResponse({ success: true });
    return true;
  }
  
  if (request?.action === 'TEST_NOTIFICATION') {
    chrome.storage.sync.get(['soundEnabled']).then((sync) => {
      const soundEnabled = sync.soundEnabled !== false && !request?.skipSound;
      dispatchJobNotification({
        id: 'test_' + Date.now(),
        title: 'تطوير وبرمجة منصة وتطبيق ويب متكامل',
        budget: '$500.00 - $1,000.00',
        category: 'تطوير المواقع والتطبيقات',
        postedTime: 'منذ دقيقة',
        description: 'مطلوب مطور لبناء منصة إدارة مشاريع متكاملة مع نظام إشعارات فوري ولوحة تحكم تفاعلية وقاعدة بيانات سريعة.',
        url: 'https://mostaql.com/projects'
      }, soundEnabled).then(() => {
        sendResponse({ success: true, message: 'Test alert & sound dispatched!' });
      });
    });
    return true;
  }
});

// Start automatic loop & offscreen document immediately
ensureOffscreenDocument();
scheduleNextAutoPoll(1);
