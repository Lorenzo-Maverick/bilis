'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.retry_reason_tracker = void 0

/**
 * @file retry-reason-tracker.js
 * @description Classifies message send failures/retries into known reasons
 *   (bad_mac, no_session, decryption_failure, server 429/463, etc) and
 *   detects "retry spirals" — a message stuck retrying repeatedly, which
 *   usually signals a broken session that needs manual intervention.
 *   Off by default.
 * @author Denzy ZeroDay
 */

const default_config = {
    enabled: false,
    max_retries: 5,
    spiral_threshold: 3,
    onSpiral: () => {}
}

class retry_reason_tracker {
    constructor(config) {
        this.config = { ...default_config, ...config }
        this.retries = new Map()
        this.total_retries = 0
        this.reason_counts = {
            no_session: 0,
            invalid_key: 0,
            bad_mac: 0,
            decryption_failure: 0,
            server_error_463: 0,
            server_error_429: 0,
            timeout: 0,
            no_route: 0,
            node_malformed: 0,
            unknown: 0
        }
        this.spirals_detected = 0
    }

    /**
     * Call when a messages.update event arrives with a status/error.
     * Classifies and records the retry.
     */
    on_message_update(update) {
        if (!this.config.enabled) return
        const msg_id = update.key?.id
        if (!msg_id) return
        if (update.status !== 0 && !update.error) return
        const reason = this.classify(update.error || update)
        this.record_retry(msg_id, reason)
    }

    /** Classify an arbitrary error object into a retry reason */
    classify(err) {
        if (!err) return 'unknown'
        const status_code = err.output?.statusCode || err.statusCode || err.status
        if (status_code === 463) return 'server_error_463'
        if (status_code === 429) return 'server_error_429'

        const error_msg = (err.message || err.text || String(err)).toLowerCase()
        if (error_msg.includes('bad mac')) return 'bad_mac'
        if (error_msg.includes('no session') || error_msg.includes('session not found'))
            return 'no_session'
        if (error_msg.includes('invalid key') || error_msg.includes('key error'))
            return 'invalid_key'
        if (error_msg.includes('decryption') || error_msg.includes('decrypt'))
            return 'decryption_failure'
        if (error_msg.includes('timeout') || error_msg.includes('timed out')) return 'timeout'
        if (
            error_msg.includes('no route') ||
            error_msg.includes('unreachable') ||
            error_msg.includes('offline')
        )
            return 'no_route'
        if (error_msg.includes('malformed') || error_msg.includes('invalid node'))
            return 'node_malformed'
        return 'unknown'
    }

    /** Record a retry for a message */
    record_retry(msg_id, reason) {
        const now = Date.now()
        let record = this.retries.get(msg_id)
        if (!record) {
            record = { msgId: msg_id, count: 0, reasons: [], firstRetry: now, lastRetry: now }
            this.retries.set(msg_id, record)
        }
        record.count++
        record.reasons.push(reason)
        record.lastRetry = now
        this.total_retries++
        this.reason_counts[reason]++

        if (record.count >= this.config.spiral_threshold) {
            this.spirals_detected++
            this.config.onSpiral(msg_id, reason)
        }
    }

    /** Should we warn the user this message is spiraling? */
    is_spiraling(msg_id) {
        const record = this.retries.get(msg_id)
        return record ? record.count >= this.config.spiral_threshold : false
    }

    /** Reset counters for a specific message (call on successful delivery) */
    clear(msg_id) {
        this.retries.delete(msg_id)
    }

    /** Get current stats */
    get_stats() {
        return {
            totalRetries: this.total_retries,
            byReason: { ...this.reason_counts },
            spiralsDetected: this.spirals_detected,
            activeRetries: this.retries.size
        }
    }

    /** Clean up old retry records (>5 minutes old) */
    cleanup() {
        const now = Date.now()
        const max_age = 5 * 60 * 1000
        for (const [msg_id, record] of this.retries.entries()) {
            if (now - record.lastRetry > max_age) this.retries.delete(msg_id)
        }
    }

    /** Destroy and clean up */
    destroy() {
        this.retries.clear()
        this.cleanup()
    }
}

exports.retry_reason_tracker = retry_reason_tracker
module.exports = { retry_reason_tracker }
