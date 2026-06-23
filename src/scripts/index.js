export * from "./core/game-logic.js"
export * from "./core/turn-rules.js"
export * from "./render/audio.js"
export * from "./render/render-logic.js"
export * from "./state/game-state.js"
export * from "./state/game-store.js"
export * from "./state/command-handler.js"
export * from "./state/god-mode.js"
export * from "./net/online-state.js"
export * from "./render/end-highlights.js"
export * from "./platform/platform.js"

import { setCommandHandler } from "./state/game-store.js";
import { commandHandler } from "./state/command-handler.js";
import { installPersistenceListener } from "./listeners/persistence-listener.js";
import { installAudioListener } from "./listeners/audio-listener.js";
import { installBotListener } from "./listeners/bot-listener.js";
import { installAnalyticsListener } from "./listeners/analytics-listener.js";
import { initNavHistory } from "./platform/nav-history.js";
import { initAnalytics } from "./platform/analytics.js";

setCommandHandler(commandHandler);
installPersistenceListener();
installAudioListener();
installBotListener();
installAnalyticsListener();
initAnalytics();
initNavHistory();
