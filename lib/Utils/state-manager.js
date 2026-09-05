"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
exports.state_manager = void 0

/**
 * @file state-manager.js
 * @description Debounced file-based persistence for anti-ban state
 *   (known chats, warmup progress, health stats, etc). Writes are
 *   debounced 5s after each send to avoid disk I/O overhead, but can
 *   be flushed immediately after critical health events (ban/restriction).
 * @author Denzy ZeroDay
 */

const fs = require('fs')

const KNOWN_CHATS_MAX = 1000
const DEBOUNCE_MS = 5000

class state_manager {
    constructor(file_path) {
        this.path = file_path
        this.debounce_timer = null
    }

    /** Load persisted state from disk. Returns null if missing/corrupt/wrong version. */
    load() {
        try {
            const raw = fs.readFileSync(this.path, 'utf-8')
            const parsed = JSON.parse(raw)
            if (parsed.version !== 3) {
                process.stderr.write('[bilis-antiban] WARN: corrupt state file or version mismatch, starting fresh\n')
                return null
            }
            return parsed
        } catch {
            if (fs.existsSync(this.path)) {
                process.stderr.write('[bilis-antiban] WARN: corrupt state file, starting fresh\n')
            }
            return null
        }
    }

    /** Debounced save — call after every send (5s delay before actual write) */
    save_debounced(state) {
        if (this.debounce_timer) clearTimeout(this.debounce_timer)
        this.debounce_timer = setTimeout(() => {
            this.write_file(state)
            this.debounce_timer = null
        }, DEBOUNCE_MS)
    }

    /** Immediate save — call after critical health events (ban/restriction) */
    save_immediate(state) {
        if (this.debounce_timer) {
            clearTimeout(this.debounce_timer)
            this.debounce_timer = null
        }
        this.write_file(state)
    }

    /** Flush/cancel pending debounced write (for tests and process exit) */
    flush() {
        if (this.debounce_timer) {
            clearTimeout(this.debounce_timer)
            this.debounce_timer = null
        }
    }

    destroy() {
        this.flush()
    }

    write_file(state) {
        const to_save = {
            ...state,
            savedAt: Date.now(),
            // LRU eviction: keep last KNOWN_CHATS_MAX entries
            knownChats: state.knownChats.length > KNOWN_CHATS_MAX
                ? state.knownChats.slice(-KNOWN_CHATS_MAX)
                : state.knownChats
        }
        try {
            fs.writeFileSync(this.path, JSON.stringify(to_save, null, 2), 'utf-8')
        } catch (err) {
            process.stderr.write(`[bilis-antiban] WARN: failed to write state to ${this.path}: ${err}\n`)
        }
    }
}

exports.state_manager = state_manager
module.exports = { state_manager }