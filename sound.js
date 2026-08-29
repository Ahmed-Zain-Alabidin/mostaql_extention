/**
 * sound.js - Bulletproof Audio Engine for Chrome Extension
 * 
 * Provides:
 * 1. Web Audio API harmonic chime (high fidelity, instant attack/decay).
 * 2. Self-contained 16-bit 44.1kHz WAV chime Data URI generator.
 * 3. HTML5 Audio element fallback (works in any DOM context).
 */

let sharedAudioCtx = null;
let cachedWavDataUri = null;

/**
 * Generates an embedded, crystal-clear 2-tone chime WAV audio Data URI
 */
export function generateChimeWavDataUri() {
  if (cachedWavDataUri) return cachedWavDataUri;

  const sampleRate = 44100;
  const duration = 0.55; // 550ms
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = new Int16Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Tone 1: 587.33 Hz (D5) - warm bell onset
    const env1 = Math.exp(-t * 9);
    const s1 = Math.sin(2 * Math.PI * 587.33 * t) * env1 * 0.45;

    // Tone 2: 880.0 Hz (A5) - bright chime decay
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

  // 'RIFF' chunk descriptor
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, chunkSize, true);
  view.setUint32(8, 0x57415645, false); // 'WAVE'

  // 'fmt ' sub-chunk
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);          // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);           // AudioFormat (1 = PCM)
  view.setUint16(22, 1, true);           // NumChannels (1 = Mono)
  view.setUint32(24, sampleRate, true);  // SampleRate
  view.setUint32(28, byteRate, true);    // ByteRate
  view.setUint16(32, blockAlign, true);  // BlockAlign
  view.setUint16(34, 16, true);          // BitsPerSample

  // 'data' sub-chunk
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
  cachedWavDataUri = 'data:audio/wav;base64,' + base64;
  return cachedWavDataUri;
}

/**
 * Plays a pleasant, audible alert chime using Web Audio with HTML5 fallback.
 */
export async function playNotificationSound() {
  // Strategy 1: Web Audio API (instant, low latency)
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
        sharedAudioCtx = new AudioCtx();
      }

      if (sharedAudioCtx.state === 'suspended') {
        await sharedAudioCtx.resume();
      }

      const now = sharedAudioCtx.currentTime;

      // Note 1: 587.33 Hz (D5)
      const osc1 = sharedAudioCtx.createOscillator();
      const gain1 = sharedAudioCtx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      gain1.gain.setValueAtTime(0.4, now);
      gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      osc1.connect(gain1);
      gain1.connect(sharedAudioCtx.destination);
      osc1.start(now);
      osc1.stop(now + 0.35);

      // Note 2: 880.0 Hz (A5)
      const osc2 = sharedAudioCtx.createOscillator();
      const gain2 = sharedAudioCtx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880.0, now + 0.12);
      gain2.gain.setValueAtTime(0.0001, now);
      gain2.gain.setValueAtTime(0.5, now + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
      osc2.connect(gain2);
      gain2.connect(sharedAudioCtx.destination);
      osc2.start(now + 0.12);
      osc2.stop(now + 0.75);

      return true;
    }
  } catch (webAudioErr) {
    console.warn('[Sound Engine] Web Audio synthesizer notice:', webAudioErr);
  }

  // Strategy 2: HTML5 Audio with embedded base64 WAV chime
  try {
    const uri = generateChimeWavDataUri();
    const audio = new Audio(uri);
    audio.volume = 1.0;
    await audio.play();
    return true;
  } catch (html5Err) {
    console.error('[Sound Engine] HTML5 Audio fallback failed:', html5Err);
    return false;
  }
}
