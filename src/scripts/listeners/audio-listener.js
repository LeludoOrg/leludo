/**
 * Audio listener — plays game sounds in response to events. Replaces
 * the inline playCaptureSound() call in the old selectToken capture
 * loop.
 */

import { EVENTS, subscribe } from '../state/game-store.js';
import { playCaptureSound } from '../render/audio.js';

export function installAudioListener() {
    subscribe((event) => {
        // `silent` marks captures replayed during an online catch-up burst (a
        // backlog of frames after a hidden tab / reconnect) — state applies but
        // a machine-gun of capture sounds would be noise, not feedback.
        if (event.type === EVENTS.TOKEN_CAPTURED && !event.silent) playCaptureSound();
    });
}
