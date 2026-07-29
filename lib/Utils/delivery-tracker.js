"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
exports.DeliveryTracker = void 0

/**
 * @file delivery-tracker.js
 * @description Tracks actual WA message delivery rate vs sent.
 *   Low delivery rate (<60%) = strong soft-ban signal.
 *   Hook into messages.update event to track delivery receipts.
 *   Ported from baileys-antiban to CJS for bilis.
 * @author Denzy ZeroDay (port), original by baileys-antiban contributors
 */

const DEFAULT_CONFIG = {
    windowMs: 3600000,      // 1 hour
    minSampleSize: 10,
    onLowDeliveryRate: () => {},
    lowRateThreshold: 0.6   // 60%
}

class DeliveryTracker {
    /**
     * @param {object} config - Optional config overrides
     * @param {number} config.windowMs - Window for rate calculation in ms (default: 1h)
     * @param {number} config.minSampleSize - Min messages before rate is meaningful (default: 10)
     * @param {number} config.lowRateThreshold - Low delivery rate threshold (default: 0.6)
     * @param {function} config.onLowDeliveryRate - Callback when delivery rate drops below threshold
     */
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config }
        this.messages = new Map()
        this.lastLowRateAlert = 0
    }

    /**
     * Register a sent message.
     * Call this after sock.sendMessage() succeeds.
     * @param {string} msgId - Message ID from msg.key.id
     */
    onMessageSent(msgId) {
        this.messages.set(msgId, { sentAt: Date.now(), delivered: false })
        this._prune()
    }

    /**
     * Mark a message as delivered.
     * Hook into sock.ev.on('messages.update') and check update.update.status === 3 or 4.
     * @param {string} msgId - Message ID
     */
    onDeliveryReceipt(msgId) {
        const record = this.messages.get(msgId)
        if (record) record.delivered = true
        this._prune()
        this._checkRate()
    }

    /**
     * Get current delivery statistics.
     * @returns {{ sentInWindow, deliveredInWindow, deliveryRate, windowMs }}
     */
    getStats() {
        this._prune()
        const now = Date.now()
        const cutoff = now - this.config.windowMs
        let sentInWindow = 0
        let deliveredInWindow = 0
        for (const record of this.messages.values()) {
            if (record.sentAt >= cutoff) {
                sentInWindow++
                if (record.delivered) deliveredInWindow++
            }
        }
        return {
            sentInWindow,
            deliveredInWindow,
            deliveryRate: sentInWindow >= this.config.minSampleSize
                ? deliveredInWindow / sentInWindow
                : null,
            windowMs: this.config.windowMs
        }
    }

    /**
     * Reset all tracked messages.
     */
    reset() {
        this.messages.clear()
        this.lastLowRateAlert = 0
    }

    _prune() {
        const cutoff = Date.now() - this.config.windowMs
        for (const [msgId, record] of this.messages.entries()) {
            if (record.sentAt < cutoff) this.messages.delete(msgId)
        }
    }

    _checkRate() {
        const stats = this.getStats()
        if (stats.deliveryRate === null) return
        const now = Date.now()
        if (now - this.lastLowRateAlert < 3600000) return
        if (stats.deliveryRate < this.config.lowRateThreshold) {
            this.lastLowRateAlert = now
            this.config.onLowDeliveryRate(stats.deliveryRate)
        }
    }
}

exports.DeliveryTracker = DeliveryTracker
module.exports = { DeliveryTracker }