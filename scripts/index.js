export * from "./game-logic.js"
export * from "./turn-rules.js"
export * from "./audio.js"
export * from "./render-logic.js"
export * from "./game-state.js"
export * from "./game-store.js"
export * from "./command-handler.js"
export * from "./god-mode.js"

import { setCommandHandler } from "./game-store.js";
import { commandHandler } from "./command-handler.js";
import { installPersistenceListener } from "./listeners/persistence-listener.js";
import { installAudioListener } from "./listeners/audio-listener.js";
import { installBotListener } from "./listeners/bot-listener.js";
import { initNavHistory } from "./nav-history.js";

setCommandHandler(commandHandler);
installPersistenceListener();
installAudioListener();
installBotListener();
initNavHistory();
