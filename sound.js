/**
 * sound.js - Bulletproof Audio Engine for Mostaql Extension
 * 
 * Plays the custom MP3 notification sound:
 * 'soynoviembre-short-digital-notification-alert-440353.mp3'
 * 
 * Uses multi-strategy playback:
 * 1. Web Audio API with pre-decoded AudioBuffer (bypasses media autoplay restrictions).
 * 2. DOM / HTML5 Audio Element playback.
 * 3. Web Audio dual-tone synthesizer fallback.
 * 4. Self-contained 16-bit WAV Data URI.
 */

const CUSTOM_AUDIO_FILE = 'soynoviembre-short-digital-notification-alert-440353.mp3';

let sharedAudioCtx = null;
let cachedAudioBuffer = null;
let isDecoding = false;

function getAudioUrl() {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    try {
      return chrome.runtime.getURL(CUSTOM_AUDIO_FILE);
    } catch {}
  }
  return CUSTOM_AUDIO_FILE;
}

function getAudioContext() {
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      sharedAudioCtx = new AudioCtx();
    }
  }
  return sharedAudioCtx;
}

/**
 * Preloads and decodes the audio file for instant low-latency playback
 */
async function getDecodedAudioBuffer(ctx) {
  if (cachedAudioBuffer) return cachedAudioBuffer;
  if (isDecoding) {
    // Wait for in-progress decode
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (cachedAudioBuffer) return cachedAudioBuffer;
    }
  }

  isDecoding = true;
  try {
    const url = getAudioUrl();
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    cachedAudioBuffer = await ctx.decodeAudioData(arrayBuffer);
    return cachedAudioBuffer;
  } catch (err) {
    console.warn('[Sound Engine] Could not decode MP3 into AudioBuffer:', err);
    return null;
  } finally {
    isDecoding = false;
  }
}

/**
 * Primary function to play the notification sound
 */
export async function playNotificationSound() {
  const url = getAudioUrl();

  // Strategy 1: Web Audio API (decodeAudioData & buffer source)
  // This is the most reliable way in Chrome extension offscreen & popup pages
  try {
    const ctx = getAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const buffer = await getDecodedAudioBuffer(ctx);
      if (buffer) {
        const source = ctx.createBufferSource();
        const gainNode = ctx.createGain();
        gainNode.gain.value = 1.0;

        source.buffer = buffer;
        source.connect(gainNode);
        gainNode.connect(ctx.destination);
        source.start(0);
        return true;
      }
    }
  } catch (webAudioErr) {
    console.warn('[Sound Engine] Strategy 1 (Web Audio Buffer) notice:', webAudioErr);
  }

  // Strategy 2: DOM Audio element or HTML5 Audio
  try {
    const domAudio = typeof document !== 'undefined' ? document.getElementById('alertAudio') : null;
    const audio = domAudio || new Audio(url);
    audio.volume = 1.0;
    audio.currentTime = 0;

    const playPromise = audio.play();
    if (playPromise !== undefined) {
      await playPromise;
      return true;
    }
  } catch (html5Err) {
    console.warn('[Sound Engine] Strategy 2 (HTML5 Audio) notice:', html5Err);
  }

  // Strategy 3: Web Audio Synthesizer Harmonic Chime
  try {
    const ctx = getAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const now = ctx.currentTime;

      // Note 1: 587.33 Hz (D5)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      gain1.gain.setValueAtTime(0.5, now);
      gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.35);

      // Note 2: 880.0 Hz (A5)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880.0, now + 0.12);
      gain2.gain.setValueAtTime(0.0001, now);
      gain2.gain.setValueAtTime(0.6, now + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.12);
      osc2.stop(now + 0.75);

      return true;
    }
  } catch (synthErr) {
    console.warn('[Sound Engine] Strategy 3 (Synthesizer) notice:', synthErr);
  }

  // Strategy 4: Fallback WAV Data URI
  try {
    const uri = generateChimeWavDataUri();
    const audio = new Audio(uri);
    audio.volume = 1.0;
    await audio.play();
    return true;
  } catch (wavErr) {
    console.error('[Sound Engine] All sound strategies failed:', wavErr);
    return false;
  }
}

/**
 * Generates an embedded 2-tone chime WAV audio Data URI
 */
export function generateChimeWavDataUri() {
  const sampleRate = 44100;
  const duration = 0.55;
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = new Int16Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env1 = Math.exp(-t * 9);
    const s1 = Math.sin(2 * Math.PI * 587.33 * t) * env1 * 0.45;

    let s2 = 0;
    if (t >= 0.1) {
      const t2 = t - 0.1;
      const env2 = Math.exp(-t2 * 6.5);
      s2 = Math.sin(2 * Math.PI * 880.0 * t2) * env2 * 0.55;
    }

    const sample = Math.max(-1, Math.min(1, s1 + s2));
    buffer[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }

  const byteRate = sampleRate * 2;
  const blockAlign = 2;
  const dataSize = numSamples * 2;
  const chunkSize = 36 + dataSize;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // 'RIFF'
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, chunkSize, true);
  view.setUint32(8, 0x57415645, false);

  // 'fmt '
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);

  // 'data'
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, dataSize, true);

  const wavBytes = new Uint8Array(44 + dataSize);
  wavBytes.set(new Uint8Array(header), 0);
  wavBytes.set(new Uint8Array(buffer.buffer), 44);

  let binary = '';
  for (let i = 0; i < wavBytes.length; i++) {
    binary += String.fromCharCode(wavBytes[i]);
  }

  const base64 = typeof btoa !== 'undefined' ? btoa(binary) : Buffer.from(wavBytes).toString('base64');
  return 'data:audio/wav;base64,' + base64;
}
