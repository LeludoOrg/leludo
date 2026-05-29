const SOUND_MUTED_KEY = "sound-muted";
let _soundMuted = localStorage.getItem(SOUND_MUTED_KEY) === "true";

export function isSoundMuted() {
    return _soundMuted;
}

export function setSoundMuted(muted) {
    _soundMuted = !!muted;
    localStorage.setItem(SOUND_MUTED_KEY, _soundMuted);
}

let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) audioCtx = new AudioContext();
    return audioCtx;
}

function playBeep({ startFreq, endFreq, startGain, duration }) {
    if (_soundMuted) return;
    const ctx = getAudioCtx();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(startFreq, t);
    if (endFreq !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration * 0.8);
    }
    gain.gain.setValueAtTime(startGain, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.start(t);
    osc.stop(t + duration);
}

// Like playBeep but supports a scheduled delay, waveform, and a short
// attack — used to build the multi-note launch/finish jingles.
function playTone({ startFreq, endFreq, startGain, duration, delay = 0, type = "sine" }) {
    if (_soundMuted) return;
    const ctx = getAudioCtx();
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(startFreq, t);
    if (endFreq !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration * 0.9);
    }
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(startGain, t + Math.min(0.02, duration * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.start(t);
    osc.stop(t + duration + 0.02);
}

export function playClickSound() {
    playBeep({ startFreq: 1200, endFreq: 800, startGain: 0.06, duration: 0.05 });
}

// Pawn leaving the yard — a playful rising "blast off" whoosh capped with
// a bright little pop.
export function playLaunchSound() {
    if (_soundMuted) return;
    playTone({ startFreq: 260, endFreq: 920, startGain: 0.10, duration: 0.28, type: "triangle" });
    playTone({ startFreq: 520, endFreq: 1500, startGain: 0.05, duration: 0.30, type: "sine" });
    playTone({ startFreq: 1500, endFreq: 2300, startGain: 0.06, duration: 0.09, delay: 0.22, type: "square" });
}

// Pawn reaching the finish — an ascending major arpeggio "ta-da!" with a
// shimmer on top.
export function playFinishSound() {
    if (_soundMuted) return;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => {
        playTone({ startFreq: f, startGain: 0.09, duration: 0.2, delay: i * 0.09, type: "triangle" });
    });
    playTone({ startFreq: 1568, endFreq: 2093, startGain: 0.05, duration: 0.38, delay: 0.33, type: "sine" });
}

export function playStepSound() {
    playBeep({ startFreq: 600, startGain: 0.08, duration: 0.06 });
}

let captureBuffer = null;
let captureBufferLoading = null;
const CAPTURE_URL = new URL("../assets/sounds/capture.m4a", import.meta.url).href;

function loadCaptureBuffer() {
    if (captureBuffer) return Promise.resolve(captureBuffer);
    if (captureBufferLoading) return captureBufferLoading;
    const ctx = getAudioCtx();
    captureBufferLoading = fetch(CAPTURE_URL)
        .then(r => r.arrayBuffer())
        .then(buf => ctx.decodeAudioData(buf))
        .then(decoded => { captureBuffer = decoded; return decoded; });
    return captureBufferLoading;
}

export function playCaptureSound() {
    if (_soundMuted) return;
    const ctx = getAudioCtx();
    loadCaptureBuffer().then(buffer => {
        if (_soundMuted) return;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = 0.3;
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start();
    });
}

export function playDiceSound() {
    if (_soundMuted) return;
    const ctx = getAudioCtx();
    const t = ctx.currentTime;

    const bufferLen = Math.ceil(ctx.sampleRate * 0.06);
    const noiseBuffer = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferLen; i++) data[i] = Math.random() * 2 - 1;

    const burstCount = 7 + Math.floor(Math.random() * 5);
    let offset = 0;
    let amp = 0.12;

    for (let i = 0; i < burstCount; i++) {
        const duration = 0.003 + Math.random() * 0.005;
        const startTime = t + offset;

        const noise = ctx.createBufferSource();
        noise.buffer = noiseBuffer;

        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(3000 + Math.random() * 2000, startTime);
        lp.Q.setValueAtTime(0.1, startTime);

        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.setValueAtTime(300 + Math.random() * 200, startTime);
        hp.Q.setValueAtTime(0.1, startTime);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(amp, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

        noise.connect(hp);
        hp.connect(lp);
        lp.connect(gain);
        gain.connect(ctx.destination);

        noise.start(startTime);
        noise.stop(startTime + duration);

        offset += 0.01 + Math.random() * 0.025;
        amp *= 0.7 + Math.random() * 0.15;
    }
}
