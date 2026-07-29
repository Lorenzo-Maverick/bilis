'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.RateLimiter = void 0

/**
 * @file rate-limiter.js
 * @description Human-like rate limiting for WhatsApp message sending.
 *   Prevents ban by enforcing per-minute/hour/day limits with gaussian jitter.
 *   Ported from baileys-antiban to CJS for bilis.
 * @author Denzy ZeroDay (port), Kobus Wentzel (original)
 */

const MS_PER_MINUTE = 60000
const MS_PER_HOUR = 3600000
const MS_PER_DAY = 86400000
const BURST_RESET_MS = 30000
const IDENTICAL_WINDOW_MS = 3600000

const DEFAULT_CONFIG = {
    maxPerMinute: 8,
    maxPerHour: 200,
    maxPerDay: 1500,
    minDelayMs: 1500,
    maxDelayMs: 5000,
    newChatDelayMs: 3000,
    maxIdenticalMessages: 3,
    burstAllowance: 3,
    identicalMessageWindowMs: IDENTICAL_WINDOW_MS
}

class RateLimiter {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config }
        this.originalConfig = { ...this.config }
        this.messages = []
        this.identicalCount = new Map()
        this.knownChats = new Set()
        this.burstCount = 0
        this.lastMessageTime = 0
    }

    /**
     * Calculate delay before next message can be sent.
     * Returns 0 if ok, -1 if blocked (daily/identical limit).
     */
    async getDelay(recipient, content) {
        const now = Date.now()
        this._cleanup(now)
        const contentHash = this._hash(content)

        // Daily limit
        const dayMessages = this.messages.filter((m) => now - m.timestamp < MS_PER_DAY)
        if (dayMessages.length >= this.config.maxPerDay) return -1

        // Hourly limit
        const hourMessages = this.messages.filter((m) => now - m.timestamp < MS_PER_HOUR)
        if (hourMessages.length >= this.config.maxPerHour) {
            hourMessages.sort((a, b) => a.timestamp - b.timestamp)
            const oldest = hourMessages[0]
            return Math.max(oldest.timestamp + MS_PER_HOUR - now, MS_PER_MINUTE)
        }

        // Per-minute limit
        const minuteMessages = this.messages.filter((m) => now - m.timestamp < MS_PER_MINUTE)
        if (minuteMessages.length >= this.config.maxPerMinute) {
            minuteMessages.sort((a, b) => a.timestamp - b.timestamp)
            const oldest = minuteMessages[0]
            return Math.max(oldest.timestamp + MS_PER_MINUTE - now, 1000)
        }

        // Identical message spam check
        const tracker = this.identicalCount.get(contentHash)
        if (tracker && now - tracker.firstSeen < this.config.identicalMessageWindowMs) {
            if (tracker.count >= this.config.maxIdenticalMessages) return -1
        }

        // Human-like delay calculation
        let delay = 0
        if (this.burstCount < this.config.burstAllowance) {
            this.burstCount++
            delay = this._jitter(this.config.minDelayMs * 0.5, this.config.minDelayMs)
        } else {
            delay = this._jitter(this.config.minDelayMs, this.config.maxDelayMs)
        }

        // Extra delay for new chats
        if (!this.knownChats.has(recipient)) {
            delay += this._jitter(this.config.newChatDelayMs * 0.5, this.config.newChatDelayMs)
        }

        // Minimum time since last message
        const timeSinceLast = now - this.lastMessageTime
        if (timeSinceLast < this.config.minDelayMs) {
            delay = Math.max(delay, this.config.minDelayMs - timeSinceLast)
        }

        // Typing simulation delay based on content length
        const typingDelay = Math.min(content.length * 30, 3000)
        delay += this._jitter(typingDelay * 0.5, typingDelay)

        return Math.round(delay)
    }

    /**
     * Record a sent message
     */
    record(recipient, content) {
        const now = Date.now()
        const contentHash = this._hash(content)

        if (now - this.lastMessageTime > BURST_RESET_MS) this.burstCount = 0

        this.messages.push({ timestamp: now, recipient, contentHash })
        this.knownChats.add(recipient)
        this.lastMessageTime = now

        const tracker = this.identicalCount.get(contentHash)
        if (tracker) {
            if (now - tracker.firstSeen < this.config.identicalMessageWindowMs) {
                tracker.count++
                tracker.lastSeen = now
            } else {
                this.identicalCount.set(contentHash, { count: 1, firstSeen: now, lastSeen: now })
            }
        } else {
            this.identicalCount.set(contentHash, { count: 1, firstSeen: now, lastSeen: now })
        }
    }

    /**
     * Get current stats
     */
    getStats() {
        const now = Date.now()
        this._cleanup(now)
        return {
            lastMinute: this.messages.filter((m) => now - m.timestamp < MS_PER_MINUTE).length,
            lastHour: this.messages.filter((m) => now - m.timestamp < MS_PER_HOUR).length,
            lastDay: this.messages.filter((m) => now - m.timestamp < MS_PER_DAY).length,
            limits: {
                perMinute: this.config.maxPerMinute,
                perHour: this.config.maxPerHour,
                perDay: this.config.maxPerDay
            },
            knownChats: this.knownChats.size,
            currentFactor: this.getCurrentFactor()
        }
    }

    /**
     * Scale rate limits by factor (0.1–1.0)
     */
    adaptLimits(factor) {
        const f = Math.max(0.1, Math.min(1.0, factor))
        this.config.maxPerMinute = Math.max(1, Math.floor(this.originalConfig.maxPerMinute * f))
        this.config.maxPerHour = Math.max(5, Math.floor(this.originalConfig.maxPerHour * f))
        this.config.maxPerDay = Math.max(20, Math.floor(this.originalConfig.maxPerDay * f))
        const delayScale = 1 + (1 - f) * 2
        this.config.minDelayMs = Math.floor(this.originalConfig.minDelayMs * delayScale)
        this.config.maxDelayMs = Math.floor(this.originalConfig.maxDelayMs * delayScale)
    }

    getCurrentFactor() {
        return this.config.maxPerMinute / this.originalConfig.maxPerMinute
    }

    getKnownChats() {
        return this.knownChats
    }

    restoreKnownChats(chats) {
        for (const jid of chats) this.knownChats.add(jid)
    }

    injectTimestamps(timestamps) {
        const now = Date.now()
        const recent = timestamps.filter((ts) => now - ts < MS_PER_DAY)
        const existing = new Set(this.messages.map((m) => m.timestamp))
        for (const ts of recent) {
            if (!existing.has(ts)) {
                this.messages.push({
                    timestamp: ts,
                    recipient: '__injected__',
                    contentHash: '__injected__'
                })
            }
        }
        const max = Math.max(...recent, 0)
        if (max > this.lastMessageTime) this.lastMessageTime = max
        this.messages.sort((a, b) => a.timestamp - b.timestamp)
    }

    _cleanup(now) {
        this.messages = this.messages.filter((m) => now - m.timestamp < MS_PER_DAY)
        for (const [hash, tracker] of this.identicalCount.entries()) {
            if (now - tracker.lastSeen > this.config.identicalMessageWindowMs) {
                this.identicalCount.delete(hash)
            }
        }
        if (this.identicalCount.size > 10000) {
            const sorted = [...this.identicalCount.entries()].sort(
                ([, a], [, b]) => a.lastSeen - b.lastSeen
            )
            const excess = this.identicalCount.size - 10000
            for (let i = 0; i < excess; i++) this.identicalCount.delete(sorted[i][0])
        }
    }

    /** Gaussian-ish jitter for human-like timing */
    _jitter(min, max) {
        const u1 = Math.random()
        const u2 = Math.random()
        const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
        const normalized = (normal + 3) / 6
        const clamped = Math.max(0, Math.min(1, normalized))
        return Math.round(min + clamped * (max - min))
    }

    /** Simple hash for content dedup */
    _hash(content) {
        let hash = 0
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i)
            hash = (hash << 5) - hash + char
            hash |= 0
        }
        return hash.toString(36)
    }
}

exports.RateLimiter = RateLimiter
module.exports = { RateLimiter }
