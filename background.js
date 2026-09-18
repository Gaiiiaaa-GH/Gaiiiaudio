/**
 * Gaiiiaudio - Background service worker
 * Sole purpose: the opt-in volume booster. The mixer/rules feature needs no
 * background script at all (content scripts talk to chrome.storage directly).
 *
 * Only one tab can be boosted at a time, and only while it is the focused,
 * active tab. Losing focus tears the whole capture down immediately and
 * hands control back to the per-domain rule (see src/content/bridge.js).
 */

let boostedTabId = null;
let boostedGain = 1.0;
let creatingOffscreen = null;

// Toolbar badge: rule count normally, a distinct warm color while boosting
// so an active boost stays visible without opening the popup.
async function updateBadge() {
  if (boostedTabId !== null) {
    chrome.action.setBadgeText({ text: 'B' });
    chrome.action.setBadgeBackgroundColor({ color: '#c47a6a' });
    chrome.action.setBadgeTextColor?.({ color: '#f1f0ea' });
    return;
  }
  const { rules } = await chrome.storage.local.get('rules');
  const count = Array.isArray(rules) ? rules.length : 0;
  chrome.action.setBadgeText({ text: count ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#d8d3c5' });
  chrome.action.setBadgeTextColor?.({ color: '#141615' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.rules) updateBadge();
});

updateBadge();

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen/audio-processor.html',
    reasons: ['USER_MEDIA'],
    justification: 'Captures a single tab audio stream to apply an opt-in volume boost.'
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}

async function closeOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

async function notifyPassthrough(tabId, enabled) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: enabled ? 'ENTER_BOOST_PASSTHROUGH' : 'EXIT_BOOST_PASSTHROUGH' });
  } catch {}
}

async function stopBoost() {
  if (boostedTabId === null) return;
  const tabId = boostedTabId;
  boostedTabId = null;
  boostedGain = 1.0;
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' });
  } catch {}
  await closeOffscreenDocument();
  await notifyPassthrough(tabId, false);
  updateBadge();
}

async function startBoost(tabId, gain) {
  if (boostedTabId !== null && boostedTabId !== tabId) await stopBoost();

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    tabId,
    streamId,
    gain
  });

  if (!response?.success) {
    await closeOffscreenDocument();
    throw new Error(response?.error || 'Capture impossible sur cet onglet (site protege ou restreint).');
  }

  boostedTabId = tabId;
  boostedGain = gain;
  await notifyPassthrough(tabId, true);
  updateBadge();
}

// Boost only ever makes sense on the focused, active tab. Any of these
// events means it no longer is, so tear the capture down immediately.
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (boostedTabId !== null && activeInfo.tabId !== boostedTabId) stopBoost();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (boostedTabId === null) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) { stopBoost(); return; }
  try {
    const tab = await chrome.tabs.get(boostedTabId);
    if (tab.windowId !== windowId || !tab.active) stopBoost();
  } catch {
    stopBoost();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === boostedTabId) stopBoost();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === boostedTabId && changeInfo.url) stopBoost();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === 'offscreen') return;

  if (msg.type === 'START_BOOST') {
    startBoost(msg.tabId, msg.gain)
      .then(() => sendResponse({ success: true, boostedTabId, boostedGain }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'SET_BOOST_GAIN') {
    if (boostedTabId === null) { sendResponse({ success: false }); return true; }
    boostedGain = msg.gain;
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'SET_GAIN', gain: msg.gain }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'STOP_BOOST') {
    stopBoost().then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'GET_BOOST_STATE') {
    sendResponse({ boostedTabId, boostedGain });
    return true;
  }
});
