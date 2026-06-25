// Release channel registry — the ONE source of truth for every channel, its
// Play track, and its Android versionCode band. Imported by
// tools/sync-android-version.mjs (band math) and tools/build-www.mjs (channel
// validation). The BACKEND mapping (prod → prod Worker, every test channel →
// the isolated beta Worker) lives in scripts/net/net-client.js because that is
// browser code; keep the two in sync conceptually.
//
//   versionCode = band * BAND_WIDTH + base,  base = major*10000 + minor*100 + patch
//
// Why these band numbers (the rule that must never be broken):
// Play serves a user who qualifies for MULTIPLE tracks the build with the
// HIGHEST versionCode. So:
//   - production must be the LOWEST band — a tester is never pulled "down" onto
//     the public build, and it keeps the natural small code players might see.
//   - each more-internal test track must sit ABOVE the less-internal ones, i.e.
//     internal > closed > open > production. A user enrolled in several tracks
//     then stays on the most internal build they qualify for, and once a prod
//     release ships it never out-numbers (and so never hides) a test build.
//
// Bands are spaced BAND_WIDTH (1e8) apart. base is < 1e6 for any major < 100, so
// a build's base never bleeds into the next band, and 1e8 spacing fits 21 bands
// (0..20) under Play's 2_100_000_000 versionCode ceiling — every Play track plus
// plenty of room for future channels.
//
// Adding a channel: give it the next free band ABOVE production but ordered by
// how internal it is (more internal = higher band), pick its Play `track`, add
// a CI job, and (if it needs its own backend) extend net-client.js. NEVER renumber
// an existing band — a lower versionCode can't be re-uploaded to Play — and never
// exceed band 20.

export const BAND_WIDTH = 100_000_000;

// Ordered low band → high band = production → most-internal test track.
export const CHANNELS = {
  prod:   { band: 0, track: 'production' }, // public production
  open:   { band: 1, track: 'open' },       // open testing — reserved for future use
  closed: { band: 2, track: 'closed' },     // closed testing / alpha — reserved
  beta:   { band: 3, track: 'internal' },   // internal testing — the current "beta" channel
};

export const CHANNEL_NAMES = Object.keys(CHANNELS);

/** True if `channel` is a known release channel. */
export function isValidChannel(channel) {
  return Object.prototype.hasOwnProperty.call(CHANNELS, channel);
}

/** Channel-banded Android versionCode for a semver string. */
export function computeVersionCode(version, channel = 'prod') {
  const semver = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!semver) throw new Error('VERSION not semver: ' + version);
  const entry = CHANNELS[channel];
  if (!entry) {
    throw new Error(`unknown release channel: '${channel}' (expected one of ${CHANNEL_NAMES.join(', ')})`);
  }
  const [, maj, min, pat] = semver.map(Number);
  const base = maj * 10000 + min * 100 + pat;
  return entry.band * BAND_WIDTH + base;
}
