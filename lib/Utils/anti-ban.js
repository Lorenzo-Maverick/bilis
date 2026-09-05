"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
exports.anti_ban = void 0

/**
 * @file anti-ban.js
 * @description Main orchestrator that wires together every anti-ban module
 *   (rate_limiter, warm_up, health_monitor, timelock_guard, reply_ratio_guard,
 *   contact_graph_warmer, presence_choreographer, retry_reason_tracker,
 *   post_reconnect_throttle, and optionally an external lid_resolver /
 *   jid_canonicalizer) into one simple call pattern:
 *
 *     const ab = new anti_ban('moderate')             // or 'conservative' / 'aggressive' / {preset, ...overrides}
 *     const decision = await ab.before_send(jid, text)
 *     if (!decision.allowed) return                    // skip / retry later
 *     if (decision.delayMs) await sleep(decision.delayMs)
 *     await sock.sendMessage(jid, { text })
 *     ab.after_send(jid, text)
 *
 *     sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
 *       if (connection === 'close') ab.on_disconnect(lastDisconnect?.error?.output?.statusCode)
 *       if (connection === 'open') ab.on_reconnect()
 *     })
 *
 * @author Denzy ZeroDay
 */

const { RateLimiter: rate_limiter } = require('./rate-limiter')
const { WarmUp: warm_up } = require('./warmup')
const { health_monitor } = require('./health-monitor')
const { timelock_guard } = require('./timelock-guard')
const { reply_ratio_guard } = require('./reply-ratio-guard')
const { contact_graph_warmer } = require('./contact-graph-warmer')
const { presence_choreographer } = require('./presence-choreographer')
const { retry_reason_tracker } = require('./retry-reason-tracker')
const { PostReconnectThrottle: post_reconnect_throttle } = require('./reconnect-throttle')
const { resolve_antiban_config } = require('./antiban-presets')
const { should_use_group_profile, apply_group_multiplier } = require('./antiban-profiles')
const { state_manager } = require('./state-manager')

class anti_ban {
    /**
     * @param {string|object} input - preset name ('conservative'|'moderate'|'aggressive'), or { preset, ...overrides }, or nothing
     * @param {object} warm_up_state - optional restored warmup state (skip if using config.persist)
     */
    constructor(input, warm_up_state) {
        const cfg = resolve_antiban_config(input)
        this.resolved_config = cfg
        this.state_manager_instance = null

        let saved_state = null
        if (cfg.persist) {
            this.state_manager_instance = new state_manager(cfg.persist)
            saved_state = this.state_manager_instance.load()
            if (saved_state) warm_up_state = saved_state.warmup
        }

        this.logging = cfg.logging ?? true
        this._log = (msg) => { if (this.logging) process.stdout.write(`[anti_ban] ${msg}\n`) }

        this.rate_limiter = new rate_limiter({
            maxPerMinute: cfg.maxPerMinute,
            maxPerHour: cfg.maxPerHour,
            maxPerDay: cfg.maxPerDay,
            minDelayMs: cfg.minDelayMs,
            maxDelayMs: cfg.maxDelayMs,
            newChatDelayMs: cfg.newChatDelayMs
        })
        if (saved_state?.knownChats) this.rate_limiter.restoreKnownChats(saved_state.knownChats)

        this.warm_up = new warm_up({
            warmUpDays: cfg.warmupDays,
            day1Limit: cfg.day1Limit,
            growthFactor: cfg.growthFactor,
            inactivityThresholdHours: cfg.inactivityThresholdHours
        }, warm_up_state)

        this.health = new health_monitor({
            auto_pause_at: cfg.autoPauseAt,
            onRiskChange: (status) => {
                const emoji = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' }
                this._log(`${emoji[status.risk]} Risk level: ${status.risk.toUpperCase()} (score: ${status.score})`)
                this._log(status.recommendation)
                status.reasons.forEach(r => this._log(`  → ${r}`))
            }
        })

        this.timelock_guard = new timelock_guard({
            onTimelockDetected: (state) => {
                this.health.record_reachout_timelock(state.enforcement_type)
                this._log(`REACHOUT TIMELOCKED — ${state.enforcement_type || 'unknown'}, expires ${state.expires_at?.toISOString?.() || 'unknown'}`)
            },
            onTimelockLifted: () => {
                this._log('Timelock lifted — resuming new contact messages')
            }
        })

        this.reply_ratio_guard = new reply_ratio_guard()
        this.contact_graph_warmer = new contact_graph_warmer()
        this.presence_choreographer = new presence_choreographer()
        this.retry_reason_tracker = new retry_reason_tracker({
            onSpiral: (msg_id, reason) => {
                this._log(`⚠️  Message ${msg_id} stuck in retry spiral (${reason})`)
            }
        })
        this.reconnect_throttle = new post_reconnect_throttle({
            baselineRatePerMinute: () => this.rate_limiter.getStats().limits.perMinute
        })

        // Optional external LID support — pass config.lid_resolver / config.jid_canonicalizer yourself.
        // These are not bundled here (see tahap 2 / LID support), but anti_ban will use them if provided.
        this.lid_resolver = null
        this.jid_canonicalizer = null
        this.session_stability_monitor = null

        this.stats = { messagesAllowed: 0, messagesBlocked: 0, totalDelayMs: 0 }
    }

    /**
     * Check if a message can be sent and compute the required human-like delay.
     * Call this BEFORE every sock.sendMessage().
     * @returns {{ allowed: boolean, delayMs: number, reason?: string, health: object, warmUpDay?: number }}
     */
    async before_send(recipient, content) {
        const health_status = this.health.get_status()

        if (this.health.is_paused()) {
            this.stats.messagesBlocked++
            this._log(`⛔ BLOCKED — health risk too high (${health_status.risk})`)
            return { allowed: false, delayMs: 0, reason: `Health risk ${health_status.risk}: ${health_status.recommendation}`, health: health_status }
        }

        const timelock_decision = this.timelock_guard.can_send(recipient)
        if (!timelock_decision.allowed) {
            this.stats.messagesBlocked++
            this._log(`TIMELOCKED — ${timelock_decision.reason}`)
            return { allowed: false, delayMs: 0, reason: timelock_decision.reason, health: health_status }
        }

        if (!this.warm_up.canSend()) {
            this.stats.messagesBlocked++
            const warm_up_status = this.warm_up.getStatus()
            this._log(`⏳ BLOCKED — warm-up day ${warm_up_status.day}/${warm_up_status.totalDays}, limit reached (${warm_up_status.todaySent}/${warm_up_status.todayLimit})`)
            return {
                allowed: false, delayMs: 0,
                reason: `Warm-up limit: ${warm_up_status.todaySent}/${warm_up_status.todayLimit} messages today (day ${warm_up_status.day})`,
                health: health_status, warmUpDay: warm_up_status.day
            }
        }

        const contact_graph_decision = this.contact_graph_warmer.can_message(recipient)
        if (!contact_graph_decision.allowed) {
            this.stats.messagesBlocked++
            this._log(`📊 BLOCKED — contact graph: ${contact_graph_decision.reason}`)
            return { allowed: false, delayMs: 0, reason: `Contact graph: ${contact_graph_decision.reason}`, health: health_status }
        }

        const reply_ratio_decision = this.reply_ratio_guard.before_send(recipient)
        if (!reply_ratio_decision.allowed) {
            this.stats.messagesBlocked++
            this._log(`💬 BLOCKED — reply ratio: ${reply_ratio_decision.reason}`)
            return { allowed: false, delayMs: 0, reason: `Reply ratio: ${reply_ratio_decision.reason}`, health: health_status }
        }

        const reconnect_decision = this.reconnect_throttle.beforeSend()
        if (!reconnect_decision.allowed) {
            this.stats.messagesBlocked++
            this._log(`🔄 BLOCKED — reconnect throttle: ${reconnect_decision.reason}`)
            return { allowed: false, delayMs: reconnect_decision.retryAfterMs || 0, reason: reconnect_decision.reason || 'Post-reconnect throttle', health: health_status }
        }

        if (this.resolved_config.groupProfiles && should_use_group_profile(recipient)) {
            const group_limits = apply_group_multiplier(
                { maxPerMinute: this.resolved_config.maxPerMinute, maxPerHour: this.resolved_config.maxPerHour, maxPerDay: this.resolved_config.maxPerDay },
                this.resolved_config.groupMultiplier
            )
            const stats = this.rate_limiter.getStats()
            if (stats.lastMinute >= group_limits.maxPerMinute || stats.lastHour >= group_limits.maxPerHour || stats.lastDay >= group_limits.maxPerDay) {
                this.stats.messagesBlocked++
                this._log(`🚫 BLOCKED — group rate limit exceeded for ${recipient}`)
                return { allowed: false, delayMs: 0, reason: 'Group rate limit exceeded', health: health_status }
            }
        }

        let delay = await this.rate_limiter.getDelay(recipient, content)
        if (delay === -1) {
            this.stats.messagesBlocked++
            this._log('🚫 BLOCKED — rate limit or identical message spam')
            return { allowed: false, delayMs: 0, reason: 'Rate limit exceeded or identical message spam detected', health: health_status }
        }

        const activity_factor = this.presence_choreographer.get_current_activity_factor()
        if (activity_factor < 1) {
            const multiplier = Math.min(5, 1 / activity_factor)
            delay = Math.floor(delay * multiplier)
        }

        const distraction_check = this.presence_choreographer.should_pause_for_distraction()
        if (distraction_check.pause) {
            delay += distraction_check.duration_ms
            this._log(`⏸️  Distraction pause: +${Math.floor(distraction_check.duration_ms / 60000)}min`)
        }

        const offline_check = this.presence_choreographer.should_take_offline_gap()
        if (offline_check.offline) {
            delay += offline_check.duration_ms
            this._log(`📴 Offline gap: +${Math.floor(offline_check.duration_ms / 60000)}min`)
        }

        this.stats.totalDelayMs += delay
        return { allowed: true, delayMs: delay, health: health_status }
    }

    /** Record a successfully sent message. Call this AFTER every successful sendMessage(). */
    after_send(recipient, content) {
        this.rate_limiter.record(recipient, content)
        this.warm_up.record()
        this.reply_ratio_guard.record_sent(recipient)
        this.stats.messagesAllowed++
        this.persist_state_debounced()
    }

    /** Record a failed message send */
    after_send_failed(error) {
        this.health.record_message_failed(error)
    }

    /** Record a disconnection (call from connection.update handler) */
    on_disconnect(reason) {
        this.health.record_disconnect(reason)
        this.reconnect_throttle.onDisconnect()
        const reason_str = String(reason)
        if (reason_str === '403' || reason_str === '401' || reason_str === 'forbidden' || reason_str === 'loggedOut') {
            this.persist_state_immediate()
        }
    }

    /** Record a successful reconnection */
    on_reconnect() {
        this.health.record_reconnect()
        this.reconnect_throttle.onReconnect()
    }

    /**
     * Handle incoming message — records in reply ratio + contact graph.
     * Returns suggested reply if reply ratio suggests an auto-reply.
     */
    on_incoming_message(jid, msg_text) {
        this.reply_ratio_guard.record_received(jid)
        this.contact_graph_warmer.on_incoming_message(jid)
        return this.reply_ratio_guard.suggest_reply(jid, msg_text)
    }

    /** Get comprehensive stats across all enabled modules */
    get_stats() {
        const stats = {
            ...this.stats,
            health: this.health.get_status(),
            warmUp: this.warm_up.getStatus(),
            rateLimiter: this.rate_limiter.getStats()
        }
        if (this.reply_ratio_guard.config?.enabled) stats.replyRatio = this.reply_ratio_guard.get_stats()
        if (this.contact_graph_warmer.config?.enabled) stats.contactGraph = this.contact_graph_warmer.get_stats()
        if (this.presence_choreographer.config?.enabled) stats.presence = this.presence_choreographer.get_stats()
        if (this.retry_reason_tracker.config?.enabled) stats.retryTracker = this.retry_reason_tracker.get_stats()
        if (this.reconnect_throttle.config?.enabled) stats.reconnectThrottle = this.reconnect_throttle.getStats()
        if (this.lid_resolver) stats.lidResolver = this.lid_resolver.getStats?.()
        if (this.jid_canonicalizer) stats.jidCanonicalizer = this.jid_canonicalizer.getStats?.()
        if (this.session_stability_monitor) stats.sessionStability = this.session_stability_monitor.get_stats()
        return stats
    }

    /** Force pause all sending */
    pause() {
        this.health.set_paused(true)
        this._log('⏸️  Sending paused manually')
    }

    /** Resume sending */
    resume() {
        this.health.set_paused(false)
        this._log('▶️  Sending resumed')
    }

    /** Reset everything (use after a ban period) */
    reset() {
        this.timelock_guard.reset()
        this.health.reset()
        this.warm_up.reset()
        this.reply_ratio_guard.reset()
        this.contact_graph_warmer.reset()
        this.presence_choreographer.reset()
        this.retry_reason_tracker.destroy()
        this.reconnect_throttle.destroy()
        this.stats = { messagesAllowed: 0, messagesBlocked: 0, totalDelayMs: 0 }
        this._log('🔄 Reset — starting fresh warm-up')
    }

    /** Export warm-up state for persistence between restarts */
    export_warmup_state() {
        return this.warm_up.exportState()
    }

    persist_state_debounced() {
        if (!this.state_manager_instance) return
        this.state_manager_instance.save_debounced({
            warmup: this.warm_up.exportState(),
            knownChats: Array.from(this.rate_limiter.getKnownChats()),
            savedAt: Date.now(),
            version: 3
        })
    }

    persist_state_immediate() {
        if (!this.state_manager_instance) return
        this.state_manager_instance.save_immediate({
            warmup: this.warm_up.exportState(),
            knownChats: Array.from(this.rate_limiter.getKnownChats()),
            savedAt: Date.now(),
            version: 3
        })
    }

    /** Clean up all timers and resources. Call when disposing the instance or when the socket closes. */
    destroy() {
        this.state_manager_instance?.destroy()
        this.timelock_guard.reset()
        this.reply_ratio_guard.reset()
        this.contact_graph_warmer.reset()
        this.presence_choreographer.reset()
        this.retry_reason_tracker.destroy()
        this.reconnect_throttle.destroy()
        this.session_stability_monitor?.reset()
        this._log('🧹 Destroyed — all timers cleared')
    }
}

exports.anti_ban = anti_ban
module.exports = { anti_ban }