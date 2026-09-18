/**
 * Gaiiiaudio - Isolated world bridge
 * Resolves the effective volume for this frame's domain (rule or manual
 * override) and forwards it to the MAIN-world patch. Also answers the popup.
 */
(() => {
  const domain = location.hostname.replace(/^www\./i, '').toLowerCase();
  let override = null; // 0-100, null = no manual override, rule applies
  let rulesCache = [];
  let boosted = false; // true while background.js owns this tab's audio via capture

  function matchRule(rules) {
    const matches = (rules || []).filter(r =>
      r?.pattern && r.enabled !== false && domain.includes(r.pattern.trim().toLowerCase())
    );
    if (!matches.length) return null;
    matches.sort((a, b) => b.pattern.trim().length - a.pattern.trim().length);
    return matches[0];
  }

  function currentEffectiveVolume() {
    if (override !== null) return override;
    const rule = matchRule(rulesCache);
    return rule ? rule.volume : 100;
  }

  function apply() {
    if (boosted) return; // the booster owns the audio path, rules are paused
    const pct = Math.max(0, Math.min(100, currentEffectiveVolume()));
    window.postMessage({ source: 'gaiiiaudio', type: 'SET_VOLUME', value: pct / 100 }, '*');
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'gaiiiaudio' || e.data.type !== 'READY') return;
    apply();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.rules) return;
    rulesCache = changes.rules.newValue || [];
    if (override === null) apply();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SET_VOLUME') {
      override = msg.value;
      apply();
      sendResponse({ success: true });
    } else if (msg.type === 'CLEAR_OVERRIDE') {
      override = null;
      apply();
      sendResponse({ success: true, volume: currentEffectiveVolume() });
    } else if (msg.type === 'GET_STATE') {
      sendResponse({ domain, override, ruleVolume: matchRule(rulesCache)?.volume ?? null, boosted });
    } else if (msg.type === 'ENTER_BOOST_PASSTHROUGH') {
      boosted = true;
      window.postMessage({ source: 'gaiiiaudio', type: 'SET_PASSTHROUGH', enabled: true }, '*');
      sendResponse({ success: true });
    } else if (msg.type === 'EXIT_BOOST_PASSTHROUGH') {
      boosted = false;
      window.postMessage({ source: 'gaiiiaudio', type: 'SET_PASSTHROUGH', enabled: false }, '*');
      apply();
      sendResponse({ success: true });
    }
    return true;
  });

  chrome.storage.local.get('rules').then(({ rules }) => {
    rulesCache = rules || [];
    apply();
  });
})();
