/**
 * Audio listener — plays game sounds in response to events. Replaces
 * the inline playCaptureSound() call in the old selectToken capture
 * loop.
 */

import { EVENTS, subscribe } from '../game-store.js';
import { playCaptureSound } from '../audio.js';

export function installAudioListener() {
    subscribe((event) => {
        if (event.type === EVENTS.TOKEN_CAPTURED) playCaptureSound();
    });
}
