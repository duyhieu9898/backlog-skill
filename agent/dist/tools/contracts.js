"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDesktopToolAction = isDesktopToolAction;
exports.isBrowserToolAction = isBrowserToolAction;
function isDesktopToolAction(action) {
    return action.kind.startsWith("desktop.");
}
function isBrowserToolAction(action) {
    return action.kind.startsWith("browser.");
}
