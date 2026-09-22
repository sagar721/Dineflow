// The new-order chime (FR-050: audible alert). Browsers, iOS Safari especially,
// allow sound only after a tap, so staff turn it on once per screen; the choice is
// remembered on this device. Generated with Web Audio — no sound file to load.

const KEY = 'dineflow:order-sound';
let context: AudioContext | null = null;

export function soundPreferred(): boolean {
  try { return window.localStorage.getItem(KEY) === 'on'; } catch { return false; }
}

/** Call from a tap. Unlocks audio and remembers the choice. */
export async function enableSound(): Promise<boolean> {
  try {
    context ??= new AudioContext();
    await context.resume();
    try { window.localStorage.setItem(KEY, 'on'); } catch { /* not remembered, still on */ }
    chime();
    return context.state === 'running';
  } catch {
    return false;
  }
}

export function disableSound() {
  try { window.localStorage.setItem(KEY, 'off'); } catch { /* nothing to do */ }
}

export function soundReady(): boolean {
  return context?.state === 'running';
}

/** Two short rising tones: noticeable in a noisy kitchen, not alarming. */
export function chime() {
  if (!context || context.state !== 'running') return;
  const start = context.currentTime;
  for (const [offset, frequency] of [[0, 880], [0.18, 1175]] as const) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.35, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.18);
  }
}
