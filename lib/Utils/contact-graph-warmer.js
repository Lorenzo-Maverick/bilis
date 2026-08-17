'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.contact_graph_warmer = void 0

/**
 * @file contact-graph-warmer.js
 * @description Enforces handshake progression before messaging strangers,
 *   and a lurk period before sending in newly-joined groups — mimics how
 *   a real human builds up a contact graph instead of blasting messages
 *   to unknown recipients immediately. Off by default.
 * @author Denzy ZeroDay
 */

const default_config = {
    enabled: false,
    require_handshake_before_group_send: true,
    handshake_min_delay_ms: 3600000, // 1 hour
    group_lurk_period_ms: 43200000, // 12 hours
    max_stranger_messages_per_day: 5,
    auto_register_on_incoming: true
}

class contact_graph_warmer {
    constructor(config = {}) {
        this.config = { ...default_config, ...config }
        this.contacts = new Map()
        this.groups = new Map()
        this.stranger_messages_today = 0
        this.last_stranger_reset_day = this.get_current_day()
    }

    /**
     * Check if message can be sent to this contact/group.
     * Returns { allowed: false, needs_handshake: true } if handshake required.
     */
    can_message(jid) {
        if (!this.config.enabled) return { allowed: true }

        const current_day = this.get_current_day()
        if (current_day !== this.last_stranger_reset_day) {
            this.stranger_messages_today = 0
            this.last_stranger_reset_day = current_day
        }

        if (this.is_group(jid)) return this.check_group_message(jid)
        return this.check_individual_message(jid)
    }

    /** Mark handshake as sent to this contact */
    mark_handshake_sent(jid) {
        if (!this.config.enabled) return
        if (this.is_group(jid)) return
        const record = this.contacts.get(jid) || { state: 'stranger' }
        record.state = 'handshake_sent'
        record.handshakeSentAt = Date.now()
        this.contacts.set(jid, record)
    }

    /** Mark handshake as complete with this contact */
    mark_handshake_complete(jid) {
        if (!this.config.enabled) return
        if (this.is_group(jid)) return
        const record = this.contacts.get(jid) || { state: 'stranger' }
        record.state = 'handshake_complete'
        this.contacts.set(jid, record)
    }

    /** Register a contact as known (skip handshake requirement) */
    register_known_contact(jid) {
        if (!this.config.enabled) return
        if (this.is_group(jid)) return
        const record = this.contacts.get(jid) || { state: 'stranger' }
        record.state = 'known'
        this.contacts.set(jid, record)
    }

    /** Register a group join event */
    register_group_join(group_jid) {
        if (!this.config.enabled) return
        if (!this.is_group(group_jid)) return
        this.groups.set(group_jid, { joinedAt: Date.now() })
    }

    /** Get contact state */
    get_contact_state(jid) {
        if (this.is_group(jid)) return 'known'
        return this.contacts.get(jid)?.state || 'stranger'
    }

    /** Handle incoming message — auto-register if enabled */
    on_incoming_message(jid) {
        if (!this.config.enabled) return
        if (this.is_group(jid)) return
        if (this.config.auto_register_on_incoming) this.register_known_contact(jid)
    }

    /** Get statistics */
    get_stats() {
        const known_contacts = Array.from(this.contacts.values()).filter(
            (c) => c.state === 'known'
        ).length
        const pending_handshakes = Array.from(this.contacts.values()).filter(
            (c) => c.state === 'handshake_sent'
        ).length
        const groups_joined = Array.from(this.groups.entries()).map(([group_jid, record]) => ({
            groupJid: group_jid,
            joinedAt: record.joinedAt,
            firstSendUnlocksAt: record.joinedAt + this.config.group_lurk_period_ms
        }))

        return {
            known_contacts,
            pending_handshakes,
            strangers_today: this.stranger_messages_today,
            groups_joined
        }
    }

    /** Reset all state */
    reset() {
        this.contacts.clear()
        this.groups.clear()
        this.stranger_messages_today = 0
        this.last_stranger_reset_day = this.get_current_day()
    }

    /** Export state for persistence */
    export_state() {
        return {
            contacts: Array.from(this.contacts.entries()),
            groups: Array.from(this.groups.entries()),
            strangerMessagesToday: this.stranger_messages_today,
            lastStrangerResetDay: this.last_stranger_reset_day
        }
    }

    /** Restore state from persistence */
    restore_state(state) {
        if (state?.contacts && Array.isArray(state.contacts))
            this.contacts = new Map(state.contacts)
        if (state?.groups && Array.isArray(state.groups)) this.groups = new Map(state.groups)
        if (typeof state?.strangerMessagesToday === 'number')
            this.stranger_messages_today = state.strangerMessagesToday
        if (typeof state?.lastStrangerResetDay === 'number')
            this.last_stranger_reset_day = state.lastStrangerResetDay
    }

    // Private helpers
    is_group(jid) {
        return jid.endsWith('@g.us')
    }

    get_current_day() {
        return Math.floor(Date.now() / 86400000)
    }

    check_group_message(group_jid) {
        const record = this.groups.get(group_jid)
        if (!record) return { allowed: true }

        const lurk_ends_at = record.joinedAt + this.config.group_lurk_period_ms
        if (Date.now() < lurk_ends_at) {
            const minutes_left = Math.ceil((lurk_ends_at - Date.now()) / 60000)
            return {
                allowed: false,
                reason: `Group lurk period not elapsed — wait ${minutes_left} minutes`
            }
        }
        return { allowed: true }
    }

    check_individual_message(jid) {
        const record = this.contacts.get(jid)

        if (!record || record.state === 'stranger') {
            if (this.config.require_handshake_before_group_send) {
                if (this.stranger_messages_today >= this.config.max_stranger_messages_per_day) {
                    return {
                        allowed: false,
                        reason: `Daily new-contact limit reached (${this.config.max_stranger_messages_per_day})`,
                        needs_handshake: true
                    }
                }
                this.stranger_messages_today++
            }
            return { allowed: true, needs_handshake: true }
        }

        if (record.state === 'handshake_sent') {
            if (!record.handshakeSentAt) return { allowed: true }
            const elapsed = Date.now() - record.handshakeSentAt
            if (elapsed < this.config.handshake_min_delay_ms) {
                const minutes_left = Math.ceil(
                    (this.config.handshake_min_delay_ms - elapsed) / 60000
                )
                return {
                    allowed: false,
                    reason: `Handshake too recent — wait ${minutes_left} minutes`
                }
            }
        }

        return { allowed: true }
    }
}

exports.contact_graph_warmer = contact_graph_warmer
module.exports = { contact_graph_warmer }
