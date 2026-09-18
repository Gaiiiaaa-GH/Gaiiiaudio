/**
 * Gaiiiaudio - Offscreen booster pipeline
 * Only one capture is ever active at a time (single global boosted tab).
 *
 * ponytail: DynamicsCompressorNode is a soft safety net, not a hard ceiling
 * (its makeup gain isn't guaranteed to prevent clipping at 300% on already
 * hot source audio). Upgrade to an AudioWorklet look-ahead peak limiter if
 * real clipping shows up in practice.
 */

let pipeline = null; // { stream, ctx, source, gainNode, compressorNode }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.streamId, msg.gain)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'SET_GAIN') {
    setGain(msg.gain);
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'STOP_CAPTURE') {
    stopCapture();
    sendResponse({ success: true });
    return true;
  }
});

async function startCapture(streamId, gain) {
  stopCapture();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);

  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.max(1, Math.min(3, gain));

  // Acts as a peak limiter near the ceiling, not a compressor: it should stay
  // transparent for anything below ~-3dB and only catch what the boost pushes
  // over the top, otherwise the "boost" is largely squashed right back out.
  const compressorNode = ctx.createDynamicsCompressor();
  compressorNode.threshold.setValueAtTime(-3, ctx.currentTime);
  compressorNode.knee.setValueAtTime(6, ctx.currentTime);
  compressorNode.ratio.setValueAtTime(20, ctx.currentTime);
  compressorNode.attack.setValueAtTime(0.001, ctx.currentTime);
  compressorNode.release.setValueAtTime(0.1, ctx.currentTime);

  source.connect(gainNode);
  gainNode.connect(compressorNode);
  compressorNode.connect(ctx.destination);

  stream.getAudioTracks().forEach(track => { track.onended = stopCapture; });

  pipeline = { stream, ctx, source, gainNode, compressorNode };
}

function setGain(gain) {
  if (!pipeline) return;
  pipeline.gainNode.gain.setValueAtTime(Math.max(1, Math.min(3, gain)), pipeline.ctx.currentTime);
}

function stopCapture() {
  if (!pipeline) return;
  try {
    pipeline.stream.getTracks().forEach(t => t.stop());
    pipeline.ctx.close();
  } catch {}
  pipeline = null;
}
