/* ==========================================================================
   Shinzora · Ringtone
   --------------------------------------------------------------------------
   A ring and a join tone, synthesised with the Web Audio API rather than
   shipped as an audio file.

   Why: an <audio> file is one more request that can 404 on a slow connection,
   it needs a user gesture in every browser anyway, and a silent ring is the
   same as no ring. Three oscillators and a gain envelope cannot fail that way.

   Browsers block audio until the page has been interacted with, so the context
   is created lazily on the first ring and resumed if it starts suspended. If it
   still cannot play, that is a browser policy, not a bug in the call — nothing
   here throws.
   ========================================================================== */

let ctx = null;

function context() {
  try {
    if (!ctx) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      ctx = new AudioCtor();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

function tone(audio, { freq, at, duration = 0.18, gain = 0.05, type = "sine" }) {
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const start = audio.currentTime + at;
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(amp).connect(audio.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/**
 * A repeating ring — two rising tones, then a pause — until the returned
 * function is called.
 * @returns {() => void} stop
 */
export function joinRingtone() {
  const audio = context();
  if (!audio) return () => {};

  const pattern = () => {
    tone(audio, { freq: 660, at: 0, duration: 0.22, gain: 0.06 });
    tone(audio, { freq: 880, at: 0.26, duration: 0.22, gain: 0.06 });
  };

  pattern();
  const timer = setInterval(pattern, 1800);

  return () => {
    clearInterval(timer);
    /* Cutting the oscillators is not possible after they start, but the pattern
       stopping is what the ear notices. */
  };
}

/** One short two-note tone: somebody joined, or the call connected. */
export function connectedTone() {
  const audio = context();
  if (!audio) return;
  tone(audio, { freq: 784, at: 0, duration: 0.12, gain: 0.05 });
  tone(audio, { freq: 1046, at: 0.1, duration: 0.16, gain: 0.05 });
}

/** Lower tone when a call ends. */
export function endedTone() {
  const audio = context();
  if (!audio) return;
  tone(audio, { freq: 520, at: 0, duration: 0.16, gain: 0.05 });
  tone(audio, { freq: 392, at: 0.14, duration: 0.2, gain: 0.05 });
}
