'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.presence_choreographer = exports.get_circadian_multiplier = exports.ACTIVITY_CURVES = void 0

/**
 * @file presence-choreographer.js
 * @description Models a realistic human daily rhythm (circadian curve),
 *   Gaussian-variance typing speed with think-pauses, delayed/skipped read
 *   receipts, distraction pauses, and offline gaps. Produces a "typing plan"
 *   the caller executes step by step against sock.sendPresenceUpdate.
 *   Off by default.
 * @author Denzy ZeroDay
 */

const default_config = {
    enabled: false,
    enable_circadian_rhythm: true,
    timezone: 'UTC',
    activity_curve: 'office',
    circadian: { enabled: true, profile: 'default', timezone: 'UTC' },
    distraction_pause_probability: 0.05,
    distraction_pause_min_ms: 300000,
    distraction_pause_max_ms: 1200000,
    read_receipt_delay_min_ms: 3000,
    read_receipt_delay_max_ms: 45000,
    read_receipt_skip_probability: 0.15,
    offline_gap_probability: 0.03,
    offline_gap_min_ms: 300000,
    offline_gap_max_ms: 900000,
    enable_typing_model: true,
    typing_wpm: 45,
    typing_wpm_std_dev: 15,
    think_pause_probability: 0.08,
    think_pause_min_ms: 800,
    think_pause_max_ms: 3500,
    intermittent_paused_probability: 0.4,
    typing_max_ms: 90000,
    typing_min_ms: 600
}

const ACTIVITY_CURVES = {
    office: [
        0.1,
        0.1,
        0.1,
        0.1,
        0.1,
        0.1,
        0.1,
        0.1, // 0-7: night quiet
        0.5,
        0.5, // 8-9: morning ramp
        0.95,
        0.95, // 10-11: morning peak
        0.6, // 12: lunch dip
        0.9,
        0.9,
        0.9,
        0.9, // 13-16: afternoon
        0.6,
        0.6, // 17-18: wind-down
        0.4,
        0.4, // 19-20: evening
        0.2,
        0.2,
        0.2,
        0.2 // 21-24: taper
    ],
    social: [
        0.1,
        0.1,
        0.1,
        0.1,
        0.1,
        0.1,
        0.1,
        0.1, // 0-7: night quiet
        0.3,
        0.4, // 8-9: slow start
        0.7,
        0.8, // 10-11: ramp up
        0.5, // 12: lunch
        0.7,
        0.7, // 13-14: afternoon
        0.4, // 15: tea time dip
        0.8,
        0.9,
        0.9, // 16-18: active
        0.6, // 19: dinner dip
        0.8,
        0.85,
        0.9,
        0.95,
        1 // 20-24: evening peak
    ],
    global: [
        0.5,
        0.5,
        0.5,
        0.5,
        0.5,
        0.5, // 0-5: night
        0.4,
        0.4, // 6-7: dawn dip
        0.6,
        0.7,
        0.8,
        0.8, // 8-11: morning
        0.6, // 12: lunch
        0.8,
        0.8,
        0.8,
        0.8, // 13-16: afternoon
        0.7,
        0.7, // 17-18: evening
        0.6,
        0.5,
        0.5,
        0.5,
        0.5,
        0.5 // 19-24: night taper
    ]
}
exports.ACTIVITY_CURVES = ACTIVITY_CURVES

/**
 * Compute the circadian activity multiplier for a given moment.
 * >1 = slower/less active (night), ~1 = normal, <1 would mean faster (not used here).
 */
function get_circadian_multiplier(date = new Date(), profile = 'default', timezone) {
    if (profile === 'always_on') return 1

    let hour
    if (timezone) {
        try {
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone,
                hour: 'numeric',
                hour12: false
            })
            const parts = formatter.formatToParts(date)
            const hour_part = parts.find((p) => p.type === 'hour')
            hour = hour_part ? parseInt(hour_part.value, 10) : date.getHours()
        } catch {
            hour = date.getHours()
        }
    } else {
        hour = date.getHours()
    }

    let shifted_hour = hour
    if (profile === 'nightOwl') shifted_hour = (hour - 3 + 24) % 24
    else if (profile === 'earlyBird') shifted_hour = (hour + 2) % 24

    if (shifted_hour >= 9 && shifted_hour < 22) {
        const t = (shifted_hour - 9) / 13
        return 1 + 0.2 * Math.cos(2 * Math.PI * t)
    } else if (shifted_hour >= 22 && shifted_hour < 24) {
        const t = (shifted_hour - 22) / 2
        return 1.2 + 1.3 * t
    } else if (shifted_hour >= 0 && shifted_hour < 2) {
        const t = shifted_hour / 2
        return 2.5 + 1.5 * t
    } else if (shifted_hour >= 2 && shifted_hour < 6) {
        const t = (shifted_hour - 2) / 4
        return 5 + 1 * Math.cos(Math.PI * t)
    } else {
        const t = (shifted_hour - 6) / 3
        return 4 - 3 * t
    }
}
exports.get_circadian_multiplier = get_circadian_multiplier

class presence_choreographer {
    constructor(config = {}) {
        this.config = {
            ...default_config,
            ...config,
            circadian: { ...default_config.circadian, ...(config.circadian || {}) }
        }
        this.stats = {
            distractionPausesInjected: 0,
            offlineGapsInjected: 0,
            readReceiptsDelayed: 0,
            readReceiptsSkipped: 0,
            typingPlansComputed: 0,
            typingPlansExecuted: 0,
            totalTypingTimeMs: 0
        }
    }

    /**
     * Get current activity factor (0.1 to 1.0).
     * Higher = more active = shorter delays. If circadian disabled, returns 1.0.
     */
    get_current_activity_factor() {
        if (!this.config.enabled || !this.config.enable_circadian_rhythm) return 1
        const hour = this.get_local_hour()
        const curve = ACTIVITY_CURVES[this.config.activity_curve]
        return curve[hour] || 0.5
    }

    /** Check if should pause for distraction. Returns { pause, duration_ms } */
    should_pause_for_distraction() {
        if (!this.config.enabled) return { pause: false, duration_ms: 0 }
        if (Math.random() < this.config.distraction_pause_probability) {
            const duration_ms = this.random_between(
                this.config.distraction_pause_min_ms,
                this.config.distraction_pause_max_ms
            )
            this.stats.distractionPausesInjected++
            return { pause: true, duration_ms }
        }
        return { pause: false, duration_ms: 0 }
    }

    /** Check if should take offline gap. Returns { offline, duration_ms } */
    should_take_offline_gap() {
        if (!this.config.enabled) return { offline: false, duration_ms: 0 }
        if (Math.random() < this.config.offline_gap_probability) {
            const duration_ms = this.random_between(
                this.config.offline_gap_min_ms,
                this.config.offline_gap_max_ms
            )
            this.stats.offlineGapsInjected++
            return { offline: true, duration_ms }
        }
        return { offline: false, duration_ms: 0 }
    }

    /**
     * Check if should mark message as read.
     * Returns { mark: false } if skip probability hit, else { mark: true, delay_ms }.
     * Applies circadian multiplier to delay.
     */
    should_mark_read() {
        if (!this.config.enabled) return { mark: true, delay_ms: 0 }
        if (Math.random() < this.config.read_receipt_skip_probability) {
            this.stats.readReceiptsSkipped++
            return { mark: false, delay_ms: 0 }
        }
        const base_delay_ms = this.random_between(
            this.config.read_receipt_delay_min_ms,
            this.config.read_receipt_delay_max_ms
        )
        let delay_ms = base_delay_ms
        if (this.config.circadian.enabled) {
            const multiplier = get_circadian_multiplier(
                new Date(),
                this.config.circadian.profile,
                this.config.circadian.timezone
            )
            delay_ms = Math.floor(base_delay_ms * multiplier)
        }
        this.stats.readReceiptsDelayed++
        return { mark: true, delay_ms }
    }

    /**
     * Compute realistic typing duration for a message of given length.
     * Includes Gaussian WPM variance + think-pause injection + circadian timing multiplier.
     * Returns a "typing plan": array of { state, duration_ms } steps the caller should execute sequentially.
     *
     *   plan = [
     *     { state: 'composing', duration_ms: 4200 },
     *     { state: 'paused',    duration_ms: 950 },   // think pause
     *     { state: 'composing', duration_ms: 6800 },
     *     { state: 'paused',    duration_ms: 600 },   // brief stop before send
     *   ]
     */
    compute_typing_plan(message_length) {
        if (!this.config.enabled || !this.config.enable_typing_model) {
            return [{ state: 'composing', duration_ms: this.config.typing_min_ms }]
        }
        this.stats.typingPlansComputed++
        if (message_length === 0) {
            return [{ state: 'composing', duration_ms: this.config.typing_min_ms }]
        }

        const wpm_sample = this.clamp(
            this.gaussian_sample(this.config.typing_wpm, this.config.typing_wpm_std_dev),
            10,
            120
        )
        const cps = (wpm_sample * 5) / 60
        const base_ms = (message_length / cps) * 1000

        let circadian_multiplier = 1
        if (this.config.circadian.enabled) {
            circadian_multiplier = get_circadian_multiplier(
                new Date(),
                this.config.circadian.profile,
                this.config.circadian.timezone
            )
        }

        const target_ms = this.clamp(
            base_ms * circadian_multiplier,
            this.config.typing_min_ms,
            this.config.typing_max_ms
        )

        const plan = []
        let remaining_budget = target_ms
        let position = 0
        const chunk_size = 10
        const num_chunks = Math.max(1, Math.ceil(message_length / chunk_size))

        for (let i = 0; i < num_chunks && remaining_budget > 0; i++) {
            const chars_in_chunk = Math.min(chunk_size, message_length - position)
            const remaining_chunks = num_chunks - i
            const chunk_budget = remaining_budget / remaining_chunks
            const chunk_typing_ms = Math.floor(Math.min(chunk_budget, remaining_budget))
            if (chunk_typing_ms <= 0) break

            if (
                i > 0 &&
                i < num_chunks - 1 &&
                Math.random() < this.config.think_pause_probability
            ) {
                plan.push({ state: 'composing', duration_ms: chunk_typing_ms })
                remaining_budget -= chunk_typing_ms
                const base_pause_ms = this.random_between(
                    this.config.think_pause_min_ms,
                    this.config.think_pause_max_ms
                )
                const pause_ms = Math.floor(base_pause_ms * circadian_multiplier)
                plan.push({ state: 'paused', duration_ms: pause_ms })
            } else {
                if (plan.length === 0 || plan[plan.length - 1].state === 'paused') {
                    plan.push({ state: 'composing', duration_ms: chunk_typing_ms })
                } else {
                    plan[plan.length - 1].duration_ms += chunk_typing_ms
                }
                remaining_budget -= chunk_typing_ms
            }
            position += chars_in_chunk
        }

        if (Math.random() < this.config.intermittent_paused_probability) {
            const base_final_pause_ms = this.random_between(200, 800)
            const final_pause_ms = Math.floor(base_final_pause_ms * circadian_multiplier)
            plan.push({ state: 'paused', duration_ms: final_pause_ms })
        }

        if (plan.length === 0 || !plan.some((step) => step.state === 'composing')) {
            return [{ state: 'composing', duration_ms: this.config.typing_min_ms }]
        }

        return plan
    }

    /**
     * Execute a typing plan against a Baileys-shaped sock with sendPresenceUpdate(state, jid).
     * Awaits each step's duration. Updates stats.
     *
     *   await choreographer.execute_typing_plan(sock, jid, plan)
     *   await sock.sendMessage(jid, content)
     */
    async execute_typing_plan(sock, jid, plan, options) {
        this.stats.typingPlansExecuted++
        for (const step of plan) {
            if (options?.signal?.aborted) {
                await Promise.resolve(sock.sendPresenceUpdate('paused', jid))
                throw new Error('Typing plan aborted')
            }
            await Promise.resolve(sock.sendPresenceUpdate(step.state, jid))
            await this.sleep(step.duration_ms)
            this.stats.totalTypingTimeMs += step.duration_ms
        }
    }

    /** Get statistics */
    get_stats() {
        return {
            currentActivityFactor: this.get_current_activity_factor(),
            distractionPausesInjected: this.stats.distractionPausesInjected,
            offlineGapsInjected: this.stats.offlineGapsInjected,
            readReceiptsDelayed: this.stats.readReceiptsDelayed,
            readReceiptsSkipped: this.stats.readReceiptsSkipped,
            currentHourLocal: this.get_local_hour(),
            typingPlansComputed: this.stats.typingPlansComputed,
            typingPlansExecuted: this.stats.typingPlansExecuted,
            totalTypingTimeMs: this.stats.totalTypingTimeMs
        }
    }

    /** Reset statistics */
    reset() {
        this.stats = {
            distractionPausesInjected: 0,
            offlineGapsInjected: 0,
            readReceiptsDelayed: 0,
            readReceiptsSkipped: 0,
            typingPlansComputed: 0,
            typingPlansExecuted: 0,
            totalTypingTimeMs: 0
        }
    }

    // Private helpers
    get_local_hour() {
        try {
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: this.config.timezone,
                hour: 'numeric',
                hour12: false
            })
            const parts = formatter.formatToParts(new Date())
            const hour_part = parts.find((p) => p.type === 'hour')
            if (hour_part) return parseInt(hour_part.value, 10)
        } catch {}
        return new Date().getUTCHours()
    }

    random_between(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    clamp(value, min, max) {
        return Math.max(min, Math.min(max, value))
    }

    /** Generate Gaussian sample using Box-Muller transform. Returns a sample from N(mean, std_dev). */
    gaussian_sample(mean, std_dev) {
        const u1 = Math.random()
        const u2 = Math.random()
        const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
        return mean + z0 * std_dev
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }
}

exports.presence_choreographer = presence_choreographer
module.exports = { presence_choreographer, get_circadian_multiplier, ACTIVITY_CURVES }
