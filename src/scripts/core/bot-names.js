// Cheeky bot name pools — harmless, region-flavoured.

import { STORAGE_KEYS } from "../platform/storage-keys.js";
import { pick } from "./rng-util.js";

export const BOT_NAME_POOLS = {
    english: [
        "Capt Obv", "Whiffs", "Boomer", "Karen", "Reply Guy",
        "Speedrun", "Tilt Tim", "Salty Sam", "AFK Andy", "Lag Larry",
        "McBotface", "Mid Skill", "Sweatlord", "Mid Boss", "Side Qst",
        "Toaster", "NPC Vibe", "Backseat", "Loot Gob", "Edge Lord",
        "Sir Yeets", "Grass Up", "GG Gary", "Goblin", "Cope Lord",
        "Doomscrl", "Sketchy", "Cringe", "Vibechk", "Bonk Bot",
        "Tiltpilot", "Misclicks", "Side Eye", "Pog Champ", "Patchnote",
        "Dial-up", "TouchStrm", "Whoopsie", "Cope Hard", "Ratio'd",
        "WiFi Wal", "404 Brian", "CacheMiss", "Stacktrc",
        "Null Ptr", "Off-By-1", "Hard F5", "ForceQuit",
    ],
    hindi: [
        "Pappu", "Bantai", "Chacha", "Chatur", "Bhidu", "Munna",
        "Ghonchu", "Gabbar", "Lukkha", "Topibaaz", "Jugaadu", "Fattu", "Dabangg",
        "Chamcha", "Chhotu", "Lallu", "Bewakoof", "Chillar", "Champak", "Hawabaaz",
        "Pheku", "Tubelight", "Tharki", "Jhakaas", "Bhau",
        "Mota Bhai", "DaruSingh", "Gappu", "Tingu",
        "Sachin No", "Sasta SRK", "Free WiFi", "Ctrl+Bhej", "404 Bhai",
        "Auto Raja", "Panmasala", "Fwd2All",
        "ChaiSutta", "Maggi 2m", "FltrCofi", "AdrakLasi",
        "InstaReel", "DJ Babu", "No Helmet", "Rikshaw",
        "WA Status", "Fwd Karo", "Net Khtm", "Buffer",
    ],
};

export const BOT_POOL_LABELS = {
    english: "English",
    hindi: "Hindi / Hinglish",
};

const POOL_KEY = STORAGE_KEYS.BOT_NAME_POOL;

export function getActivePoolKey() {
    const stored = localStorage.getItem(POOL_KEY);
    if (stored && BOT_NAME_POOLS[stored]) return stored;
    return "english";
}

export function setActivePoolKey(key) {
    if (!BOT_NAME_POOLS[key]) return;
    localStorage.setItem(POOL_KEY, key);
    document.dispatchEvent(new CustomEvent("bot-name-pool-changed", { detail: { key } }));
}

/**
 * Pick a random bot name not already in `used`.
 * @param {string[]} used  names already taken (avoid collisions).
 * @param {object} [opts]
 * @param {string} [opts.poolKey]  force a pool ("english"|"hindi"); defaults to the
 *   localStorage-stored active pool. The server passes this explicitly because it
 *   has no localStorage.
 * @param {()=>number} [opts.rng]  RNG returning 0..1; defaults to Math.random. The
 *   server passes a seeded RNG so bot naming stays deterministic.
 */
export function randomBotName(used = [], { poolKey, rng = Math.random } = {}) {
    const key = poolKey && BOT_NAME_POOLS[poolKey] ? poolKey : getActivePoolKey();
    const pool = BOT_NAME_POOLS[key];
    const available = pool.filter(n => !used.includes(n));
    const source = available.length ? available : pool;
    return pick(source, rng);
}

export function isDefaultBotName(name) {
    return Object.values(BOT_NAME_POOLS).some(pool => pool.includes(name));
}

const SEAT_NAME_KEY = STORAGE_KEYS.SEAT_NAMES;

function readSeatNameMap() {
    try {
        const raw = localStorage.getItem(SEAT_NAME_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

export function getSavedSeatName(type, seatIndex) {
    const map = readSeatNameMap();
    return map[`${type}.${seatIndex}`] || "";
}

export function setSavedSeatName(type, seatIndex, name) {
    const map = readSeatNameMap();
    const key = `${type}.${seatIndex}`;
    if (name) map[key] = name;
    else delete map[key];
    localStorage.setItem(SEAT_NAME_KEY, JSON.stringify(map));
}
