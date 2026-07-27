"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
exports.WarmUp = void 0

/**
 * @file warmup.js
 * @description Gradual activity increase for new/reconnected WA numbers.
 *   Prevents ban by enforcing a 7-day ramp-up of messaging activity.
 *   Ported from baileys-antiban to CJS for bilis.
 * @author Denzy ZeroDay (port), original by baileys-antiban contributors
 */

const MS_PER_DAY = 86400000

/** Random growth factor in [1.5, 2.2] — avoids cross-account fingerprinting */
const randomGrowthFactor = () => Math.round((1.5 + Math.random() * 0.7) * 100) / 100

const DEFAULT_CONFIG = {
    warmUpDays: 7,
    day1Limit: 20,
    growthFactor: null, // null = randomized per instance
    inactivityThresholdHours: 72
}

class WarmUp {
    /**
     * @param {object} config - Optional config overrides
     * @param {object} existingState - Optional restored state from persistence
     */
    constructor(config = {}, existingState = null) {
        this.config = { ...DEFAULT_CONFIG, ...config }
        if (!this.config.growthFactor) {
            this.config.growthFactor = randomGrowthFactor()
        }
        this.state = existingState || this._freshState()
    }

    /**
     * Get current daily message limit based on warm-up phase.
     * Returns Infinity if graduated.
     */
    getDailyLimit() {
        if (this.state.graduated) return Infinity
        const day = this._getCurrentDay()
        if (day >= this.config.warmUpDays) {
            this.state.graduated = true
            return Infinity
        }
        return Math.round(this.config.day1Limit * Math.pow(this.config.growthFactor, day))
    }

    /**
     * Check if a message can be sent within warm-up limits.
     */
    canSend() {
        this._checkInactivity()
        if (this.state.graduated) return true
        const day = this._getCurrentDay()
        const todayCount = this.state.dailyCounts[day] || 0
        return todayCount < this.getDailyLimit()
    }

    /**
     * Record a sent message.
     */
    record() {
        const now = Date.now()
        const day = this._getCurrentDay()
        while (this.state.dailyCounts.length <= day) {
            this.state.dailyCounts.push(0)
        }
        this.state.dailyCounts[day]++
        this.state.lastActiveAt = now
    }

    /**
     * Get current warm-up status.
     */
    getStatus() {
        const day = this._getCurrentDay()
        const todaySent = this.state.dailyCounts[day] || 0
        const limit = this.getDailyLimit()
        return {
            phase: this.state.graduated ? 'graduated' : 'warming',
            day: Math.min(day + 1, this.config.warmUpDays),
            totalDays: this.config.warmUpDays,
            todayLimit: limit === Infinity ? -1 : limit,
            todaySent,
            progress: this.state.graduated ? 100 : Math.round((day / this.config.warmUpDays) * 100)
        }
    }

    /**
     * Export state for persistence (save to DB/file).
     */
    exportState() {
        const day = this._getCurrentDay()
        const todaySent = this.state.dailyCounts[day] || 0
        const todayDate = new Date().toISOString().split('T')[0]
        return { ...this.state, todaySentCount: todaySent, todayDate }
    }

    /**
     * Import state from persistence (restore from DB/file).
     */
    importState(state) {
        this.state = { ...state }
        if (state.todayDate && state.todaySentCount !== undefined) {
            const todayDate = new Date().toISOString().split('T')[0]
            if (state.todayDate === todayDate) {
                const day = this._getCurrentDay()
                while (this.state.dailyCounts.length <= day) {
                    this.state.dailyCounts.push(0)
                }
                this.state.dailyCounts[day] = Math.max(
                    this.state.dailyCounts[day] || 0,
                    state.todaySentCount
                )
            }
        }
    }

    /**
     * Reset warm-up (e.g. after detected ban risk).
     */
    reset() {
        this.state = this._freshState()
    }

    _getCurrentDay() {
        return Math.floor((Date.now() - this.state.startedAt) / MS_PER_DAY)
    }

    _checkInactivity() {
        const hoursSinceActive = (Date.now() - this.state.lastActiveAt) / 3600000
        if (hoursSinceActive > this.config.inactivityThresholdHours && this.state.graduated) {
            this.state = this._freshState()
            this.state.graduated = false
        }
    }

    _freshState() {
        const now = Date.now()
        return {
            startedAt: now,
            lastActiveAt: now,
            dailyCounts: [],
            graduated: false
        }
    }
}

exports.WarmUp = WarmUp
module.exports = { WarmUp }