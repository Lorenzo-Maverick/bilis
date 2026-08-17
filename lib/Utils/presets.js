'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.wrap_with_session_stability =
    exports.session_health_monitor =
    exports.classify_disconnect =
        void 0

/**
 * @file session-stability.js
 * @description Classifies WA disconnect status codes into actionable
 *   categories (fatal / recoverable / rate-limited / unknown) with
 *   suggested backoff, and tracks decrypt/Bad-MAC failure rate to detect
 *   a degraded session before it fully breaks.
 *   `wrap_with_session_stability` wraps a sock in a Proxy that optionally
 *   canonicalizes JIDs before sending (via an external lid_resolver) and
 *   exposes live session health stats.
 * @author Denzy ZeroDay
 */

/** Classify a WA disconnect status code into category + recommended action */
function classify_disconnect(status_code) {
    if (status_code === 401 || status_code === 440) {
        return {
            category: 'fatal',
            shouldReconnect: false,
            message: 'Logged out — restart with QR code required',
            code: status_code
        }
    }
    if (status_code === 515) {
        return {
            category: 'fatal',
            shouldReconnect: false,
            message: 'Restart required by WhatsApp — client too old or protocol mismatch',
            code: status_code
        }
    }
    if (status_code === 405) {
        return {
            category: 'fatal',
            shouldReconnect: false,
            message: 'Method not allowed — server rejected connection method',
            code: status_code
        }
    }
    if (status_code === 409 || status_code === 428) {
        return {
            category: 'fatal',
            shouldReconnect: false,
            message: 'Connection replaced — another device took over',
            code: status_code
        }
    }
    if (status_code === 412) {
        return {
            category: 'recoverable',
            shouldReconnect: true,
            backoffMs: 30000,
            message: 'Precondition failed — auth state mismatch, retry after delay',
            code: status_code
        }
    }
    if (status_code === 429) {
        return {
            category: 'rate-limited',
            shouldReconnect: true,
            backoffMs: 300000,
            message: 'Rate limited by WhatsApp — cool-off period required',
            code: status_code
        }
    }
    if (status_code === 503) {
        return {
            category: 'rate-limited',
            shouldReconnect: true,
            backoffMs: 60000,
            message: 'WhatsApp service unavailable — temporary outage',
            code: status_code
        }
    }
    if (status_code === 408) {
        return {
            category: 'recoverable',
            shouldReconnect: true,
            backoffMs: 5000,
            message: 'Connection timeout — network issue, safe to retry',
            code: status_code
        }
    }
    if (status_code === 500) {
        return {
            category: 'recoverable',
            shouldReconnect: true,
            backoffMs: 10000,
            message: 'WhatsApp internal error — temporary server issue',
            code: status_code
        }
    }
    if (status_code === 1000) {
        return {
            category: 'recoverable',
            shouldReconnect: true,
            backoffMs: 2000,
            message: 'Connection closed gracefully — safe to reconnect',
            code: status_code
        }
    }
    return {
        category: 'unknown',
        shouldReconnect: true,
        backoffMs: 15000,
        message: `Unknown disconnect reason (code ${status_code}) — reconnect with caution`,
        code: status_code
    }
}
exports.classify_disconnect = classify_disconnect

const default_health_config = {
    bad_mac_threshold: 3,
    bad_mac_window_ms: 60000
}

class session_health_monitor {
    constructor(config = {}) {
        this.config = { ...default_health_config, ...config }
        this.on_degraded = config.onDegraded
        this.on_recovered = config.onRecovered
        this.stats = { decryptSuccess: 0, decryptFail: 0, badMacCount: 0, isDegraded: false }
        this.bad_mac_timestamps = []
    }

    /** Record successful decrypt */
    record_decrypt_success() {
        this.stats.decryptSuccess++
        this.check_recovery()
    }

    /** Record failed decrypt (Bad MAC or similar) */
    record_decrypt_fail(is_bad_mac = false) {
        this.stats.decryptFail++
        if (is_bad_mac) {
            const now = Date.now()
            this.stats.badMacCount++
            this.stats.lastBadMac = new Date(now)
            this.bad_mac_timestamps.push(now)
            const cutoff = now - this.config.bad_mac_window_ms
            this.bad_mac_timestamps = this.bad_mac_timestamps.filter((ts) => ts > cutoff)

            if (
                !this.stats.isDegraded &&
                this.bad_mac_timestamps.length >= this.config.bad_mac_threshold
            ) {
                this.stats.isDegraded = true
                this.stats.degradedSince = new Date(now)
                this.on_degraded?.(this.get_stats())
            }
        }
    }

    /** Check if session has recovered from degraded state */
    check_recovery() {
        if (!this.stats.isDegraded) return
        const now = Date.now()
        const cutoff = now - this.config.bad_mac_window_ms
        this.bad_mac_timestamps = this.bad_mac_timestamps.filter((ts) => ts > cutoff)

        if (this.bad_mac_timestamps.length < this.config.bad_mac_threshold) {
            this.stats.isDegraded = false
            this.stats.degradedSince = undefined
            this.on_recovered?.(this.get_stats())
        }
    }

    /** Get current health stats */
    get_stats() {
        return { ...this.stats }
    }

    /** Reset all counters */
    reset() {
        this.stats = { decryptSuccess: 0, decryptFail: 0, badMacCount: 0, isDegraded: false }
        this.bad_mac_timestamps = []
    }
}
exports.session_health_monitor = session_health_monitor

/**
 * Wrap a Baileys sock in a Proxy that:
 * - optionally canonicalizes JIDs before sendMessage via an external lid_resolver
 * - exposes `sessionHealthStats` and `sessionHealthMonitor` getters
 *
 * @param {object} sock
 * @param {object} config
 * @param {boolean} config.canonicalJidNormalization
 * @param {boolean} config.healthMonitoring
 * @param {object} config.health - passed to session_health_monitor
 * @param {object} config.lidResolver - optional, must expose resolveCanonical(jid)
 */
function wrap_with_session_stability(sock, config = {}) {
    const {
        canonicalJidNormalization = true,
        healthMonitoring = true,
        health: health_config,
        lidResolver: lid_resolver
    } = config
    const health_monitor = healthMonitoring ? new session_health_monitor(health_config) : null

    return new Proxy(sock, {
        get(target, prop) {
            if (prop === 'sendMessage' && canonicalJidNormalization && lid_resolver) {
                return async (jid, content, options) => {
                    const canonical = lid_resolver.resolveCanonical(jid)
                    return target.sendMessage(canonical, content, options)
                }
            }
            if (prop === 'sessionHealthStats' && health_monitor) return health_monitor.get_stats()
            if (prop === 'sessionHealthMonitor' && health_monitor) return health_monitor
            return target[prop]
        }
    })
}
exports.wrap_with_session_stability = wrap_with_session_stability

module.exports = { classify_disconnect, session_health_monitor, wrap_with_session_stability }
