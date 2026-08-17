'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.timelock_guard = void 0

/**
 * @file timelock-guard.js
 * @description Tracks WA reachout timelock (463 errors) — blocks new-contact
 *   messages during timelock window, keeps known chats sending normally.
 *   Auto-schedules resume based on expiry + buffer. Fixes race condition
 *   on rapid state changes via timer generation tracking.
 * @author Denzy ZeroDay
 */

const default_config = {
    resume_buffer_ms: 10000
}

class timelock_guard {
    constructor(config = {}) {
        this.config = { ...default_config, ...config }
        this.state = { is_active: false, error_count: 0 }
        this.known_chats = new Set()
        this.resume_timer = null
        this.timer_generation = 0
    }

    /** Update timelock state from Baileys connection.update event */
    on_timelock_update(data) {
        const was_active = this.state.is_active
        this.state.is_active = !!data.isActive
        this.state.enforcement_type = data.enforcementType
        this.state.expires_at = data.timeEnforcementEnds

        if (this.state.is_active && !was_active) {
            this.state.detected_at = new Date()
            this.state.error_count = 0
            this.config.onTimelockDetected?.(this.get_state())
            this.schedule_resume()
        } else if (this.state.is_active && was_active) {
            this.schedule_resume()
        }

        if (!this.state.is_active && was_active) {
            this.clear_resume_timer()
            this.config.onTimelockLifted?.(this.get_state())
        }
    }

    /** Record a 463 error from a failed send */
    record_463_error() {
        this.state.error_count++
        if (!this.state.is_active) {
            this.state.is_active = true
            this.state.detected_at = new Date()
            this.state.expires_at = new Date(Date.now() + 60000)
            this.config.onTimelockDetected?.(this.get_state())
            this.schedule_resume()
        }
    }

    /** Register a JID as a known/existing chat (has tctoken / prior history) */
    register_known_chat(jid) {
        this.known_chats.add(jid)
    }

    /** Register multiple known chats at once (e.g. from chat list on connect) */
    register_known_chats(jids) {
        for (const jid of jids) this.known_chats.add(jid)
    }

    /** Check if a message to this recipient should be allowed */
    can_send(jid) {
        if (!this.state.is_active) return { allowed: true }

        if (this.state.expires_at) {
            const expiry_with_buffer =
                this.state.expires_at.getTime() + this.config.resume_buffer_ms
            if (Date.now() >= expiry_with_buffer) {
                this.lift()
                return { allowed: true }
            }
        }

        if (jid.endsWith('@g.us') || jid.endsWith('@newsletter')) return { allowed: true }
        if (this.known_chats.has(jid)) return { allowed: true }

        const expires_in = this.state.expires_at
            ? Math.max(0, this.state.expires_at.getTime() - Date.now())
            : 60000

        return {
            allowed: false,
            reason: `Reachout timelocked (${this.state.enforcement_type || 'unknown'}). New contacts blocked. Expires in ${Math.ceil(expires_in / 1000)}s.`
        }
    }

    /** Get current timelock state */
    get_state() {
        return { ...this.state }
    }

    /** Check if currently timelocked */
    is_timelocked() {
        if (!this.state.is_active) return false
        if (this.state.expires_at) {
            const expiry_with_buffer =
                this.state.expires_at.getTime() + this.config.resume_buffer_ms
            if (Date.now() >= expiry_with_buffer) {
                this.lift()
                return false
            }
        }
        return true
    }

    /** Get the set of known chat JIDs */
    get_known_chats() {
        return new Set(this.known_chats)
    }

    /** Manually lift the timelock */
    lift() {
        if (this.state.is_active) {
            this.state.is_active = false
            this.clear_resume_timer()
            this.config.onTimelockLifted?.(this.get_state())
        }
    }

    /** Reset all state */
    reset() {
        this.state = { is_active: false, error_count: 0 }
        this.known_chats.clear()
        this.clear_resume_timer()
    }

    schedule_resume() {
        this.clear_resume_timer()
        if (this.state.expires_at) {
            const delay =
                this.state.expires_at.getTime() - Date.now() + this.config.resume_buffer_ms
            if (delay > 0) {
                this.timer_generation++
                const current_generation = this.timer_generation
                this.resume_timer = setTimeout(() => {
                    if (current_generation === this.timer_generation) this.lift()
                }, delay)
            }
        }
    }

    clear_resume_timer() {
        if (this.resume_timer) {
            clearTimeout(this.resume_timer)
            this.resume_timer = null
            this.timer_generation++
        }
    }
}

exports.timelock_guard = timelock_guard
module.exports = { timelock_guard }
