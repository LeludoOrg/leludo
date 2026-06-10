#!/usr/bin/env node
// Rasterize the leludo brand mark (resume-card mini-board) into every
// PNG variant the app + Android build consumes.
//
// Outputs:
//   dev-assets/design/icon.png             1024×1024  master icon, full-bleed
//   dev-assets/design/icon-512.png          512×512   master icon, 512px
//   dev-assets/design/icon-foreground.png  1024×1024  adaptive foreground (transparent)
//   dev-assets/design/icon-background.png  1024×1024  solid cream background
//   dev-assets/design/splash.png           2732×2732  centered mark on cream
//   dev-assets/design/splash-dark.png      2732×2732  centered mark on dark espresso
//
//   android/.../mipmap-<density>/
//     ic_launcher.png              square launcher (cream bg + mark)
//     ic_launcher_round.png        round launcher (circular clip)
//     ic_launcher_foreground.png   adaptive foreground (transparent)
//     ic_launcher_background.png   adaptive background (solid cream)
//
//   android/.../drawable[-night][-port|-land]-<density>/splash.png
//     centered mark on cream (light) or dark espresso (night)
//
// Usage: node tools/generate-icons.mjs
// Requires @playwright/test (already a devDependency).

import { chromium } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const designDir = resolve(root, 'dev-assets/design');
const androidRes = resolve(root, 'android/app/src/main/res');

const PALETTE = {
    red:    '#C8472E',
    green:  '#3D8A5E',
    yellow: '#D7A21F',
    blue:   '#3253A8',
    crossDark: '#140F0A',
    crossAlpha: 0.22,
    centerFill: '#FAF6EC',
    centerAlpha: 0.85,
    cream: '#FAF6EC',
    espresso: '#1A1410',
};

const MIPMAP_DENSITIES = {
    ldpi: 36,
    mdpi: 48,
    hdpi: 72,
    xhdpi: 96,
    xxhdpi: 144,
    xxxhdpi: 192,
};

// Splash dimensions per density. Capacitor's default layout includes
// portrait + landscape + night variants for each density. Sizes
// mirror what already lives in android/.../res/drawable-*/splash.png.
const SPLASH_DENSITIES = {
    ldpi: { port: [240, 320], land: [320, 240] },
    mdpi: { port: [320, 480], land: [480, 320] },
    hdpi: { port: [480, 800], land: [800, 480] },
    xhdpi: { port: [720, 1280], land: [1280, 720] },
    xxhdpi: { port: [960, 1600], land: [1600, 960] },
    xxxhdpi: { port: [1280, 1920], land: [1920, 1280] },
};

// Mini-board mark on a square SVG canvas.
// `inset` pads the mark inward (used for adaptive foreground safe zone).
// `bg` fills the full canvas behind the mark; null for transparent.
// `rx` rounds the corners of the mark.
function markSvg({ size, inset = 0, bg = null, rx = 0 }) {
    const x = inset;
    const w = size - inset * 2;
    const half = w / 2;
    const third = w / 3;
    const diamond = third * 0.34;
    const cx = x + half;
    const cy = x + half;
    const bgRect = bg
        ? `<rect width="${size}" height="${size}" fill="${bg}"/>`
        : '';
    const clip = rx > 0
        ? `<defs><clipPath id="round"><rect x="${x}" y="${x}" width="${w}" height="${w}" rx="${rx}"/></clipPath></defs><g clip-path="url(#round)">`
        : '<g>';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        ${bgRect}
        ${clip}
            <rect x="${x}"        y="${x}"        width="${half}" height="${half}" fill="${PALETTE.green}"/>
            <rect x="${x + half}" y="${x}"        width="${half}" height="${half}" fill="${PALETTE.yellow}"/>
            <rect x="${x}"        y="${x + half}" width="${half}" height="${half}" fill="${PALETTE.blue}"/>
            <rect x="${x + half}" y="${x + half}" width="${half}" height="${half}" fill="${PALETTE.red}"/>
            <rect x="${x}"            y="${x + third}"     width="${w}"     height="${third}" fill="${PALETTE.crossDark}" fill-opacity="${PALETTE.crossAlpha}"/>
            <rect x="${x + third}"    y="${x}"             width="${third}" height="${w}"     fill="${PALETTE.crossDark}" fill-opacity="${PALETTE.crossAlpha}"/>
            <rect x="${-diamond / 2}" y="${-diamond / 2}"  width="${diamond}" height="${diamond}"
                  transform="translate(${cx} ${cy}) rotate(45)"
                  fill="${PALETTE.centerFill}" fill-opacity="${PALETTE.centerAlpha}"/>
        </g>
    </svg>`;
}

function solidSvg({ width, height, fill }) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${fill}"/></svg>`;
}

function splashSvg({ width, height, bg }) {
    // Mark sized to ~28% of the shortest edge so the splash reads
    // calm rather than full-bleed.
    const markSize = Math.round(Math.min(width, height) * 0.28);
    const offsetX = Math.round((width - markSize) / 2);
    const offsetY = Math.round((height - markSize) / 2);
    const rx = Math.round(markSize * 0.06);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect width="${width}" height="${height}" fill="${bg}"/>
        <g transform="translate(${offsetX} ${offsetY})">
            ${markSvg({ size: markSize, rx, bg: null })}
        </g>
    </svg>`;
}

async function renderPng(page, svg, width, height, outPath, { background = null } = {}) {
    const html = `<!doctype html><html><head><style>
        html, body { margin:0; padding:0; }
        body { ${background ? `background:${background};` : 'background:transparent;'} width:${width}px; height:${height}px; }
        svg { display:block; width:${width}px; height:${height}px; }
    </style></head><body>${svg}</body></html>`;
    await page.setViewportSize({ width, height });
    await page.setContent(html, { waitUntil: 'load' });
    const buf = await page.screenshot({
        type: 'png',
        omitBackground: !background,
        clip: { x: 0, y: 0, width, height },
    });
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, buf);
    console.log(`  ${outPath.replace(root + '/', '')} (${width}×${height})`);
}

async function generateDesignSet(page) {
    console.log('dev-assets/design/ master assets…');
    await renderPng(page,
        markSvg({ size: 1024, bg: PALETTE.cream }),
        1024, 1024,
        resolve(designDir, 'icon.png'),
        { background: PALETTE.cream });

    await renderPng(page,
        markSvg({ size: 512, bg: PALETTE.cream }),
        512, 512,
        resolve(designDir, 'icon-512.png'),
        { background: PALETTE.cream });

    await renderPng(page,
        markSvg({ size: 1024, inset: Math.round(1024 * 0.18), bg: null }),
        1024, 1024,
        resolve(designDir, 'icon-foreground.png'));

    await renderPng(page,
        solidSvg({ width: 1024, height: 1024, fill: PALETTE.cream }),
        1024, 1024,
        resolve(designDir, 'icon-background.png'),
        { background: PALETTE.cream });

    await renderPng(page,
        splashSvg({ width: 2732, height: 2732, bg: PALETTE.cream }),
        2732, 2732,
        resolve(designDir, 'splash.png'),
        { background: PALETTE.cream });

    await renderPng(page,
        splashSvg({ width: 2732, height: 2732, bg: PALETTE.espresso }),
        2732, 2732,
        resolve(designDir, 'splash-dark.png'),
        { background: PALETTE.espresso });
}

async function generateAndroidLauncher(page) {
    if (!existsSync(androidRes)) {
        console.log('android/ res tree missing, skipping launcher icons.');
        return;
    }
    console.log('android/ launcher icons…');
    for (const [density, size] of Object.entries(MIPMAP_DENSITIES)) {
        const dir = resolve(androidRes, `mipmap-${density}`);
        const fgInset = Math.round(size * 0.18);

        await renderPng(page,
            markSvg({ size, bg: PALETTE.cream }),
            size, size,
            resolve(dir, 'ic_launcher.png'),
            { background: PALETTE.cream });

        await renderPng(page,
            markSvg({ size, bg: PALETTE.cream, rx: size / 2 }),
            size, size,
            resolve(dir, 'ic_launcher_round.png'));

        await renderPng(page,
            markSvg({ size, inset: fgInset, bg: null }),
            size, size,
            resolve(dir, 'ic_launcher_foreground.png'));

        await renderPng(page,
            solidSvg({ width: size, height: size, fill: PALETTE.cream }),
            size, size,
            resolve(dir, 'ic_launcher_background.png'),
            { background: PALETTE.cream });
    }
}

async function generateAndroidSplash(page) {
    if (!existsSync(androidRes)) {
        console.log('android/ res tree missing, skipping splashes.');
        return;
    }
    console.log('android/ splash variants…');

    // drawable/ + drawable-night/ are the orientation-agnostic
    // defaults Capacitor falls back to. They mirror mdpi portrait.
    const fallback = SPLASH_DENSITIES.ldpi.port;
    const fallbackDirs = [
        { dir: 'drawable',       bg: PALETTE.cream,    size: fallback },
        { dir: 'drawable-night', bg: PALETTE.espresso, size: fallback },
    ];
    for (const { dir, bg, size } of fallbackDirs) {
        await renderPng(page,
            splashSvg({ width: size[0], height: size[1], bg }),
            size[0], size[1],
            resolve(androidRes, dir, 'splash.png'),
            { background: bg });
    }

    for (const [density, sizes] of Object.entries(SPLASH_DENSITIES)) {
        for (const orientation of ['port', 'land']) {
            const [w, h] = sizes[orientation];
            for (const night of [false, true]) {
                const bg = night ? PALETTE.espresso : PALETTE.cream;
                const seg = night ? 'night-' : '';
                const dir = `drawable-${orientation}-${seg}${density}`;
                await renderPng(page,
                    splashSvg({ width: w, height: h, bg }),
                    w, h,
                    resolve(androidRes, dir, 'splash.png'),
                    { background: bg });
            }
        }
    }
}

async function main() {
    await mkdir(designDir, { recursive: true });
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ deviceScaleFactor: 1 });
    const page = await ctx.newPage();

    try {
        await generateDesignSet(page);
        await generateAndroidLauncher(page);
        await generateAndroidSplash(page);
        console.log('Done.');
    } finally {
        await ctx.close();
        await browser.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
