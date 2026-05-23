import {
    dispatch,
    COMMANDS,
    pauseGameLogic,
    resumeGameLogic,
    isGameLogicPaused,
    isSoundMuted,
    setSoundMuted,
} from "../scripts/index.js";
import { goTo, back as navBack, registerScreenHandler } from "../scripts/nav-history.js";

function setAssistFlag(flag, value) {
    dispatch({ type: COMMANDS.SET_ASSIST_FLAG, flag, value });
}

const ASSIST_TOGGLES = [
    { id: 's-auto-roll', flag: 'autoRollDice', label: 'Auto-roll dice', storageKey: 'assist-auto-roll', default: false },
    { id: 's-auto-single', flag: 'autoMoveSingleOption', label: 'Auto-move when only one option', storageKey: 'assist-auto-single', default: false },
    { id: 's-auto-home-out', flag: 'autoMoveOutOfHome', label: 'Auto-move out of home', storageKey: 'assist-auto-home-out', default: true },
];

function readAssistPref(t) {
    const v = localStorage.getItem(t.storageKey);
    if (v === null) return t.default;
    return v === "true";
}
import {
    BOT_NAME_POOLS,
    BOT_POOL_LABELS,
    getActivePoolKey,
    setActivePoolKey,
} from "../scripts/bot-names.js";
import {
    htmlToElement,
    VERSION,
} from "./index.js"

const ICON_BACK = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;

const SETTINGS_HTML = /*html*/ `
<button id="settings-icon" class="icon-btn">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
</button>
`;

function toggleHtml(id, label, checked = false, withBorder = true) {
    return `<div class="settings-row${withBorder ? ' settings-row--bordered' : ''}">
        <label for="${id}" class="settings-row-label">${label}</label>
        <input type="checkbox" id="${id}" class="toggle-input" ${checked ? 'checked' : ''} />
        <label for="${id}" class="toggle-track">
            <div class="toggle-knob"></div>
        </label>
    </div>`;
}

function settingsGroup(label, content) {
    return `<div>
        <div class="section-label" style="margin-bottom:8px;">${label}</div>
        <div class="surface-card settings-group-card">${content}</div>
    </div>`;
}

function buildSettingsOverlay() {
    return `<div id="settings-overlay" class="frame-overlay hidden">
        <div class="frame">
            <div class="top-bar">
                <button id="settings-back" class="icon-btn">${ICON_BACK}</button>
                <div class="top-bar-title"></div>
                <div class="icon-btn-spacer"></div>
            </div>

            <div class="settings-body">
                <div class="settings-title-wrap">
                    <h2 class="settings-title">Preferences</h2>
                </div>

                <div class="settings-groups">
                ${settingsGroup('Theme', `
                    <div class="theme-row">
                        <label class="theme-tile-wrap">
                            <input type="radio" name="s-theme" value="light" class="theme-tile-input" />
                            <div class="theme-tile" style="background:#EFE9DC;color:#1F1B14;">
                                <div class="theme-tile-glyph">Aa</div>
                                <div class="theme-tile-label">Paper</div>
                            </div>
                        </label>
                        <label class="theme-tile-wrap">
                            <input type="radio" name="s-theme" value="dark" class="theme-tile-input" />
                            <div class="theme-tile" style="background:#1F1B14;color:#F2EDE3;">
                                <div class="theme-tile-glyph">Aa</div>
                                <div class="theme-tile-label">Dusk</div>
                            </div>
                        </label>
                        <label class="theme-tile-wrap">
                            <input type="radio" name="s-theme" value="system" class="theme-tile-input" />
                            <div class="theme-tile" style="background:#0d0d0d;color:#fff;">
                                <div class="theme-tile-glyph">Aa</div>
                                <div class="theme-tile-label">System</div>
                            </div>
                        </label>
                    </div>
                `)}

                ${settingsGroup('Sound', toggleHtml('s-sound', 'Sound effects', !isSoundMuted(), false))}

                ${settingsGroup('Assist', ASSIST_TOGGLES.map((t, idx, arr) => toggleHtml(t.id, t.label, readAssistPref(t), idx < arr.length - 1)).join(''))}

                ${settingsGroup('Bot vibe', `
                    <div class="bot-pool-list">
                        ${Object.keys(BOT_NAME_POOLS).map((key) => {
                            const sample = BOT_NAME_POOLS[key].slice(0, 3).join(' · ')
                            return `<label class="bot-pool-row">
                                <div class="bot-pool-body">
                                    <span class="bot-pool-name">${BOT_POOL_LABELS[key]}</span>
                                    <span class="bot-pool-sample">${sample}</span>
                                </div>
                                <input type="radio" name="s-bot-pool" value="${key}" class="bot-pool-input hidden" />
                                <span class="bot-pool-dot"></span>
                            </label>`
                        }).join('')}
                    </div>
                `)}

                ${settingsGroup('About', `
                    <div class="about-list">
                        <div class="about-row">
                            <span class="about-key">Version</span>
                            <span class="about-value-mono">${VERSION}</span>
                        </div>
                        <div class="about-row about-row--separator">
                            <span class="about-key">Source</span>
                            <a href="https://github.com/LeludoOrg/leludo" class="about-value-mono about-link">github.com/LeludoOrg/leludo</a>
                        </div>
                        <div class="about-row about-row--separator">
                            <span class="about-key">Privacy</span>
                            <a href="privacy.html" class="about-link">Read policy</a>
                        </div>
                    </div>
                `)}
                </div>
            </div>
        </div>
    </div>`;
}

function updateTheme(theme) {
    const rootElement = window.document.documentElement
    rootElement.classList.remove("dark", "light", "system")

    const themeToApply = theme === "system" ?
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? "dark" : "light") :
        theme;
    rootElement.classList.add(themeToApply)

    const headerEl = rootElement.querySelector("#header");
    if (headerEl) {
        const navElementStyles = getComputedStyle(headerEl);
        document.querySelector('meta[name="theme-color"]')
            .setAttribute('content', navElementStyles.backgroundColor);
    }

    localStorage.setItem("theme", theme)
}

let _overlayInitialized = false;
let _pausedBySettings = false;

function openSettings() {
    ensureOverlay();
    const overlay = document.getElementById('settings-overlay');
    if (!overlay.classList.contains('hidden')) return;
    const gameEl = document.getElementById('game');
    const gameVisible = gameEl && !gameEl.classList.contains('hidden');
    if (gameVisible && !isGameLogicPaused()) {
        pauseGameLogic();
        _pausedBySettings = true;
    }
    overlay.classList.remove('hidden');
    goTo('settings');
}

function closeSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.classList.add('hidden');
    if (_pausedBySettings) {
        resumeGameLogic();
        _pausedBySettings = false;
    }
}

function ensureOverlay() {
    if (_overlayInitialized) return;
    _overlayInitialized = true;

    document.body.insertAdjacentHTML('beforeend', buildSettingsOverlay());
    const overlay = document.getElementById('settings-overlay');

    overlay.querySelector("#settings-back").addEventListener("click", () => navBack());
    registerScreenHandler('settings', closeSettings);

    const defaultTheme = localStorage.getItem("theme") || "system"
    updateTheme(defaultTheme)
    const themeRadio = overlay.querySelector(`input[name="s-theme"][value="${defaultTheme}"]`);
    if (themeRadio) themeRadio.checked = true;

    overlay.querySelectorAll("input[name='s-theme']").forEach((el) => {
        el.addEventListener("change", ($event) => {
            updateTheme($event.target.value);
        })
    })

    const soundEl = overlay.querySelector('#s-sound');
    soundEl.checked = !isSoundMuted();
    soundEl.addEventListener('change', ($event) => {
        setSoundMuted(!$event.target.checked);
    });

    ASSIST_TOGGLES.forEach(t => {
        const value = readAssistPref(t);
        const el = overlay.querySelector(`#${t.id}`);
        el.checked = value;
        setAssistFlag(t.flag, value);
        el.addEventListener("change", ($event) => {
            const next = $event.target.checked;
            localStorage.setItem(t.storageKey, next);
            setAssistFlag(t.flag, next);
        });
    });

    const activePool = getActivePoolKey();
    const poolRadio = overlay.querySelector(`input[name="s-bot-pool"][value="${activePool}"]`);
    if (poolRadio) poolRadio.checked = true;
    overlay.querySelectorAll("input[name='s-bot-pool']").forEach(el => {
        el.addEventListener("change", ($event) => {
            setActivePoolKey($event.target.value);
        });
    });
}

document.addEventListener('click', (e) => {
    if (e.target.id === 'g-settings-btn' || e.target.closest('#g-settings-btn')) {
        openSettings();
    }
});

class Header extends HTMLElement {
    constructor() {
        super()
    }

    connectedCallback() {
        ensureOverlay();
        const settingsElement = htmlToElement(SETTINGS_HTML)
        settingsElement.querySelector("#settings-icon").addEventListener("click", openSettings);
        this.appendChild(settingsElement)
    }
}

window.customElements.define("wc-settings", Header)
