"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDesktopToolAction = isDesktopToolAction;
function isDesktopToolAction(action) {
    return action.kind.startsWith("desktop.");
}
