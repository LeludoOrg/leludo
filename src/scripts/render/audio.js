import { STORAGE_KEYS } from "../platform/storage-keys.js";
import { readBool, writeBool } from "../platform/storage-util.js";

const SOUND_MUTED_KEY = STORAGE_KEYS.SOUND_MUTED;
let _soundMuted = readBool(SOUND_MUTED_KEY);

export function isSoundMuted() {
    return _soundMuted;
}

export function setSoundMuted(muted) {
    _soundMuted = !!muted;
    writeBool(SOUND_MUTED_KEY, _soundMuted);
}

let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) audioCtx = new AudioContext();
    // Browsers start the context suspended until a user gesture; resume so the
    // first game sounds aren't silently dropped. Fire-and-forget (returns a
    // promise we don't need to await).
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
}

// Fill a mono buffer of `seconds` with white noise [-1, 1). Shared by the
// filtered-noise primitive and the inline dice-rattle synth.
function makeWhiteNoiseBuffer(ctx, seconds) {
    const len = Math.ceil(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
}

// Single-oscillator note: a scheduled delay, waveform, and short attack.
// Used both for one-shot blips (click/step) and the multi-note
// launch/finish jingles. The mute guard lives at the public SFX entry
// points, so this primitive runs unconditionally.
function playTone({ startFreq, endFreq, startGain, duration, delay = 0, type = "sine" }) {
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

// Rich, warm voice: a pair of slightly detuned oscillators feeding a
// lowpass that opens with the note, with an optional pitch glide and
// vibrato. Detune + filter give it body instead of a thin beep.
function playVoice({
    startFreq,
    endFreq,
    startGain,
    duration,
    delay = 0,
    type = "triangle",
    detune = 8,
    attack = 0.012,
    lpStart,
    lpEnd,
    vibratoRate = 0,
    vibratoDepth = 0,
}) {
    const ctx = getAudioCtx();
    const t = ctx.currentTime + delay;
    const end = t + duration;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(startGain, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(lpStart || Math.max(startFreq * 3, 1200), t);
    if (lpEnd !== undefined) {
        lp.frequency.exponentialRampToValueAtTime(lpEnd, end);
    }

    lp.connect(gain);
    gain.connect(ctx.destination);

    // Optional vibrato shared by both detuned oscillators.
    let lfo, lfoGain;
    if (vibratoRate > 0 && vibratoDepth > 0) {
        lfo = ctx.createOscillator();
        lfoGain = ctx.createGain();
        lfo.frequency.value = vibratoRate;
        lfoGain.gain.value = vibratoDepth;
        lfo.connect(lfoGain);
    }

    for (const cents of [-detune, detune]) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.detune.value = cents;
        osc.frequency.setValueAtTime(startFreq, t);
        if (endFreq !== undefined) {
            osc.frequency.exponentialRampToValueAtTime(endFreq, end - 0.01);
        }
        if (lfoGain) lfoGain.connect(osc.frequency);
        osc.connect(lp);
        osc.start(t);
        osc.stop(end + 0.02);
    }

    if (lfo) {
        lfo.start(t);
        lfo.stop(end + 0.02);
    }
}

// Filtered-noise gust: a band-passed swept noise burst. Used for the
// launch whoosh and the finish shimmer/cymbal swell.
function playNoise({ duration, startGain, delay = 0, lpStart, lpEnd, hpFreq = 300, Q = 0.6 }) {
    const ctx = getAudioCtx();
    const t = ctx.currentTime + delay;
    const end = t + duration;

    const src = ctx.createBufferSource();
    src.buffer = makeWhiteNoiseBuffer(ctx, duration);

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = hpFreq;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = Q;
    lp.frequency.setValueAtTime(lpStart, t);
    if (lpEnd !== undefined) lp.frequency.exponentialRampToValueAtTime(lpEnd, end);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(startGain, t + duration * 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    src.connect(hp);
    hp.connect(lp);
    lp.connect(gain);
    gain.connect(ctx.destination);
    src.start(t);
    src.stop(end + 0.02);
}

export function playClickSound() {
    if (_soundMuted) return;
    playTone({ startFreq: 1200, endFreq: 800, startGain: 0.06, duration: 0.05 });
}

// Pawn leaving the yard — a clean, joyful "pop & zip": a soft rounded pop
// for launch energy, a smooth pitch zip up as the pawn springs onto the
// board, and a single bright bell ping at the top. Same warm triangle +
// sine-bell palette as the finish fanfare so they feel like a set.
export function playLaunchSound() {
    if (_soundMuted) return;
    // Rounded pop — a low triangle blip that gives the launch a soft body
    // without the buzzy grit of a saw/square.
    playVoice({
        startFreq: 230, endFreq: 150, startGain: 0.10, duration: 0.09,
        type: "triangle", detune: 5, attack: 0.004, lpStart: 900, lpEnd: 500,
    });
    // Smooth zip up — pure triangle glide, the satisfying "spring onto the
    // board" rise. No vibrato, so it reads clean instead of wobbly.
    playVoice({
        startFreq: 360, endFreq: 1180, startGain: 0.09, duration: 0.2, delay: 0.03,
        type: "triangle", detune: 8, attack: 0.01, lpStart: 1400, lpEnd: 4200,
    });
    // Bright bell ping at the apex — one clear sparkle, no harshness.
    playTone({ startFreq: 1760, startGain: 0.06, duration: 0.22, delay: 0.18, type: "sine" });
}

// Pawn reaching the finish — a triumphant little fanfare: a bass thump
// anchors a warm major chord that blooms open, an octave hop tops it off,
// and a cascade of bell sparkles + a soft cymbal swell crown the arrival.
export function playFinishSound() {
    if (_soundMuted) return;
    // Bass root thump anchors the chord.
    playVoice({
        startFreq: 130.81, startGain: 0.10, duration: 0.5, type: "sawtooth",
        detune: 6, lpStart: 400, lpEnd: 900,
    });
    // Warm major triad blooming open, then the octave hop for the "ta-daa!".
    const chord = [
        { f: 523.25, d: 0.0 },  // C5
        { f: 659.25, d: 0.08 }, // E5
        { f: 783.99, d: 0.16 }, // G5
        { f: 1046.5, d: 0.30 }, // C6 — the lift
    ];
    chord.forEach(({ f, d }) => {
        playVoice({
            startFreq: f, startGain: 0.085, duration: 0.55 - d, delay: d,
            type: "triangle", detune: 9, lpStart: f * 2, lpEnd: f * 5,
        });
    });
    // Soft cymbal swell on the hit.
    playNoise({ duration: 0.5, startGain: 0.035, delay: 0.28, lpStart: 6000, lpEnd: 9000, hpFreq: 4000, Q: 0.4 });
    // Descending bell sparkle cascade crowning the chord.
    [2093, 1568, 1318.5].forEach((f, i) => {
        playTone({ startFreq: f, startGain: 0.05, duration: 0.3, delay: 0.34 + i * 0.07, type: "sine" });
    });
}

export function playStepSound() {
    if (_soundMuted) return;
    playTone({ startFreq: 600, startGain: 0.08, duration: 0.06 });
}

let captureBuffer = null;
let captureBufferLoading = null;
const CAPTURE_URL = new URL("../../assets/sounds/capture.m4a", import.meta.url).href;

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

    const noiseBuffer = makeWhiteNoiseBuffer(ctx, 0.06);

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
