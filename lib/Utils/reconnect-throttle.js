'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.PostReconnectThrottle = void 0

/**
 * @file reconnect-throttle.js
 * @description Throttle outbound messages after WA reconnection.
 *   Inspired by whatsapp-rust's client/sessions.rs semaphore pattern.
 *   On reconnect, gates outbound messages to a low rate then ramps
 *   back to normal over 60s — prevents burst-floods that trigger WA limits.
 *
 *   Usage:
 *     const throttle = new PostReconnectThrottle({ enabled: true })
 *     // On connection.update where connection === 'open':
 *     throttle.onReconnect()
 *     // Before sending:
 *     const decision = throttle.beforeSend()
 *     if (!decision.allowed) await sleep(decision.retryAfterMs)
 *
 *   Ported from baileys-antiban to CJS for bilis.
 * @author Denzy ZeroDay (port), Kobus Wentzel (original)
 */

const DEFAULT_CONFIG = {
    enabled: false,
    rampDurationMs: 60000, // 60s total ramp
    initialRateMultiplier: 0.1, // 10% rate initially
    rampSteps: 6, // 6 steps: 10%→25%→50%→75%→90%→100%
    baselineRatePerMinute: null // Optional getter from RateLimiter
}

const WINDOW_DURATION_MS = 60000

class PostReconnectThrottle {
    constructor(config = {}) {
        this.config = {
            ...DEFAULT_CONFIG,
            ...config,
            baselineRatePerMinute: config.baselineRatePerMinute || null
        }
        this.throttledSince = null
        this.throttledSendCount = 0
        this.lifetimeReconnects = 0
        this.rampTimer = null
        this.currentStep = 0
        this.sendsInCurrentWindow = 0
        this.currentWindowStart = 0
    }

    /** Call when connection is re-established. Starts throttle ramp. */
    onReconnect() {
        if (!this.config.enabled) return
        this.throttledSince = Date.now()
        this.currentStep = 0
        this.throttledSendCount = 0
        this.lifetimeReconnects++
        this.sendsInCurrentWindow = 0
        this.currentWindowStart = Date.now()
        if (this.rampTimer) clearTimeout(this.rampTimer)
        this._scheduleNextRampStep()
    }

    /** Call when connection drops (optional). */
    onDisconnect() {
        // Keep throttle state — prevents rapid reconnect/disconnect from resetting too early
    }

    /** Get current rate multiplier (1.0 = no throttle). */
    getCurrentMultiplier() {
        if (!this.config.enabled || !this.throttledSince) return 1.0
        const elapsed = Date.now() - this.throttledSince
        if (elapsed >= this.config.rampDurationMs) return 1.0
        const progress = this.currentStep / this.config.rampSteps
        return Math.min(
            1.0,
            this.config.initialRateMultiplier + (1.0 - this.config.initialRateMultiplier) * progress
        )
    }

    /** Check if a send is allowed. Returns { allowed, reason?, retryAfterMs? } */
    beforeSend() {
        if (!this.config.enabled || !this.throttledSince) return { allowed: true }

        const now = Date.now()
        const multiplier = this.getCurrentMultiplier()

        if (multiplier >= 1.0) {
            this.throttledSince = null
            return { allowed: true }
        }

        if (now - this.currentWindowStart >= WINDOW_DURATION_MS) {
            this.sendsInCurrentWindow = 0
            this.currentWindowStart = now
        }

        const baselineRate = this.config.baselineRatePerMinute
            ? this.config.baselineRatePerMinute()
            : 8
        const allowedInWindow = Math.max(1, Math.floor(baselineRate * multiplier))

        if (this.sendsInCurrentWindow >= allowedInWindow) {
            const windowRemaining = WINDOW_DURATION_MS - (now - this.currentWindowStart)
            return {
                allowed: false,
                reason: `Post-reconnect throttle: ${Math.floor(multiplier * 100)}% rate (${this.sendsInCurrentWindow}/${allowedInWindow} sends in window)`,
                retryAfterMs: windowRemaining
            }
        }

        this.sendsInCurrentWindow++
        this.throttledSendCount++
        return { allowed: true }
    }

    /** Get current stats */
    getStats() {
        const multiplier = this.getCurrentMultiplier()
        const isThrottled = this.throttledSince !== null && multiplier < 1.0
        return {
            isThrottled,
            currentMultiplier: multiplier,
            throttledSinceMs: this.throttledSince,
            remainingMs:
                isThrottled && this.throttledSince
                    ? Math.max(0, this.config.rampDurationMs - (Date.now() - this.throttledSince))
                    : 0,
            throttledSendCount: this.throttledSendCount,
            lifetimeReconnects: this.lifetimeReconnects
        }
    }

    /** Cleanup timers */
    destroy() {
        if (this.rampTimer) {
            clearTimeout(this.rampTimer)
            this.rampTimer = null
        }
        this.throttledSince = null
    }

    _scheduleNextRampStep() {
        if (this.currentStep >= this.config.rampSteps) {
            this.throttledSince = null
            this.rampTimer = null
            return
        }
        const stepDuration = this.config.rampDurationMs / this.config.rampSteps
        this.rampTimer = setTimeout(() => {
            this.currentStep++
            this._scheduleNextRampStep()
        }, stepDuration)
    }
}

exports.PostReconnectThrottle = PostReconnectThrottle
module.exports = { PostReconnectThrottle }
