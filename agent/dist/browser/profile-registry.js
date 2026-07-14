"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileRegistry = exports.ProfileLock = void 0;
class ProfileLock {
    promise = Promise.resolve();
    async acquire() {
        let release;
        const nextPromise = new Promise((resolve) => {
            release = resolve;
        });
        const currentPromise = this.promise;
        this.promise = nextPromise;
        await currentPromise;
        return release;
    }
}
exports.ProfileLock = ProfileLock;
class ProfileRegistry {
    states = new Map();
    locks = new Map();
    get(profileName) {
        return this.states.get(profileName);
    }
    getLock(profileName) {
        let lock = this.locks.get(profileName);
        if (!lock) {
            lock = new ProfileLock();
            this.locks.set(profileName, lock);
        }
        return lock;
    }
    register(profileName, state) {
        this.states.set(profileName, state);
    }
    list() {
        return Array.from(this.states.values());
    }
    markOperationStarted(profileName) {
        const state = this.states.get(profileName);
        if (state) {
            state.activeOperationCount++;
            state.lastUsedAt = Date.now();
        }
    }
    markOperationFinished(profileName) {
        const state = this.states.get(profileName);
        if (state) {
            state.activeOperationCount = Math.max(0, state.activeOperationCount - 1);
            state.lastUsedAt = Date.now();
        }
    }
    remove(profileName) {
        this.states.delete(profileName);
    }
}
exports.ProfileRegistry = ProfileRegistry;
