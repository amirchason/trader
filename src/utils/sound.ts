// Web Audio API tone generator — no external files needed

let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function playTone(frequency: number, duration: number, volume = 0.25) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';
    osc.frequency.value = frequency;

    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch {
    // AudioContext blocked (e.g. autoplay policy) — ignore silently
  }
}

// Two-tone ascending ding for trade entry
export function playTradeOpen() {
  playTone(880, 0.15, 0.2);
  setTimeout(() => playTone(1100, 0.25, 0.18), 120);
}

// Two-tone descending ding for trade close
export function playTradeClose() {
  playTone(660, 0.15, 0.2);
  setTimeout(() => playTone(550, 0.25, 0.18), 120);
}
