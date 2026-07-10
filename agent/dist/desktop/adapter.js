"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnavailableDesktopAdapter = void 0;
exports.getDesktopAdapter = getDesktopAdapter;
const contracts_1 = require("./contracts");
class UnavailableDesktopAdapter {
    getStatus() {
        return {
            platform: process.platform,
            capabilities: contracts_1.desktopCapabilities.map((capability) => ({
                capability,
                available: false,
                permission: {
                    state: "unavailable",
                    detail: "No reviewed desktop adapter is installed.",
                },
            })),
            displays: [],
        };
    }
}
exports.UnavailableDesktopAdapter = UnavailableDesktopAdapter;
function getDesktopAdapter() {
    return new UnavailableDesktopAdapter();
}
