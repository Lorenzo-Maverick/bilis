'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.reply_ratio_guard = void 0

/**
 * @file reply-ratio-guard.js
 * @description Tracks sent vs received ratio per contact. If a bot sends
 *   too many messages without getting replies (spam-like pattern), it
 *   triggers a cooldown and can suggest human-like auto-replies to keep
 *   the ratio healthy. Off by default.
 * @author Denzy ZeroDay
 */

const default_config = {
    enabled: false,
    min_ratio: 0.1,
    min_messages_before_enforce: 5,
    inbound_auto_reply_probability: 0.25,
    auto_reply_templates: ['👍', '👌', 'ok', 'noted', 'thanks', '🙏', 'got it'],
    cooldown_hours_on_violation: 24,
    scope: 'individual'
}

class reply_ratio_guard {
    constructor(config = {}) {
        this.config = { ...default_config, ...config }
        this.contacts = new Map()
    }

    /** Check if message can be sent to this contact based on reply ratio. Call before sending. */
    before_send(jid) {
        if (!this.config.enabled) return { allowed: true }
        if (this.is_group(jid) && this.config.scope === 'individual') return { allowed: true }

        const record = this.contacts.get(jid)
        if (!record) return { allowed: true }

        if (record.cooledUntil && Date.now() < record.cooledUntil) {
            const hours_left = Math.ceil((record.cooledUntil - Date.now()) / 3600000)
            return {
                allowed: false,
                reason: `Reply ratio cooldown — ${record.sent} sent, ${record.received} received. Retry in ${hours_left}h`
            }
        }

        if (record.sent >= this.config.min_messages_before_enforce) {
            const ratio = record.sent === 0 ? 1 : record.received / record.sent
            if (ratio < this.config.min_ratio) {
                record.cooledUntil = Date.now() + this.config.cooldown_hours_on_violation * 3600000
                return {
                    allowed: false,
                    reason: `Reply ratio too low (${(ratio * 100).toFixed(1)}% < ${(this.config.min_ratio * 100).toFixed(1)}%). Cooldown ${this.config.cooldown_hours_on_violation}h`
                }
            }
        }

        return { allowed: true }
    }

    /** Record an outbound message sent to this contact */
    record_sent(jid) {
        if (!this.config.enabled) return
        const record = this.contacts.get(jid) || { sent: 0, received: 0 }
        record.sent++
        this.contacts.set(jid, record)
    }

    /** Record an inbound message received from this contact */
    record_received(jid) {
        if (!this.config.enabled) return
        const record = this.contacts.get(jid) || { sent: 0, received: 0 }
        record.received++
        delete record.cooledUntil
        this.contacts.set(jid, record)
    }

    /**
     * Suggest whether to send an auto-reply to this incoming message.
     * Returns { should_reply: true, suggested_text: '👍' } if probability check passes.
     * Caller is responsible for actually sending the message.
     */
    suggest_reply(jid, _msg_text) {
        if (!this.config.enabled) return { should_reply: false }
        if (this.is_group(jid) && this.config.scope === 'individual') return { should_reply: false }

        if (Math.random() < this.config.inbound_auto_reply_probability) {
            const templates = this.config.auto_reply_templates
            const suggested_text = templates[Math.floor(Math.random() * templates.length)]
            return { should_reply: true, suggested_text }
        }
        return { should_reply: false }
    }

    /** Get statistics for all contacts and global metrics */
    get_stats() {
        const per_contact = Array.from(this.contacts.entries()).map(([jid, record]) => ({
            jid,
            sent: record.sent,
            received: record.received,
            ratio: record.sent === 0 ? 0 : record.received / record.sent,
            cooledUntil: record.cooledUntil
        }))
        const global_sent = per_contact.reduce((sum, c) => sum + c.sent, 0)
        const global_received = per_contact.reduce((sum, c) => sum + c.received, 0)
        const global_ratio = global_sent === 0 ? 0 : global_received / global_sent
        const contacts_on_cooldown = per_contact.filter(
            (c) => c.cooledUntil && Date.now() < c.cooledUntil
        ).length

        return { per_contact, global_sent, global_received, global_ratio, contacts_on_cooldown }
    }

    /** Reset all counters */
    reset() {
        this.contacts.clear()
    }

    /** Export state for persistence */
    export_state() {
        return { contacts: Array.from(this.contacts.entries()) }
    }

    /** Restore state from persistence */
    restore_state(state) {
        if (state?.contacts && Array.isArray(state.contacts)) {
            this.contacts = new Map(state.contacts)
        }
    }

    /** Check if JID is a group */
    is_group(jid) {
        return jid.endsWith('@g.us')
    }
}

exports.reply_ratio_guard = reply_ratio_guard
module.exports = { reply_ratio_guard }
