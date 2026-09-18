/**
 * Gaiiiaudio - MAIN world patch
 * Owns HTMLMediaElement.volume: the page can still write to it, but the
 * actual output is always the extension's target, not the page's request.
 */
(() => {
  if (window.__gaiiiaudioPatched) return;
  window.__gaiiiaudioPatched = true;

  let target = 1;
  let passthrough = false; // true while the booster owns this tab's audio path
  const nativeVolume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');

  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    configurable: true,
    get() { return nativeVolume.get.call(this); },
    set(requestedByPage) { nativeVolume.set.call(this, passthrough ? requestedByPage : target); }
  });

  function forceAll() {
    document.querySelectorAll('video, audio').forEach(el => nativeVolume.set.call(el, target));
  }

  new MutationObserver((mutations) => {
    if (passthrough) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('video, audio')) nativeVolume.set.call(node, target);
        node.querySelectorAll?.('video, audio').forEach(el => nativeVolume.set.call(el, target));
      }
    }
  }).observe(document, { childList: true, subtree: true });

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'gaiiiaudio') return;
    if (e.data.type === 'SET_VOLUME') {
      target = e.data.value;
      if (!passthrough) forceAll();
    } else if (e.data.type === 'SET_PASSTHROUGH') {
      passthrough = e.data.enabled;
      if (!passthrough) forceAll();
    }
  });

  // Tell the isolated-world bridge we're ready to receive the effective volume,
  // regardless of which world's content script finished registering first.
  window.postMessage({ source: 'gaiiiaudio', type: 'READY' }, '*');
})();
