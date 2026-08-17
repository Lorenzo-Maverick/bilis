'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.health_monitor = void 0

/**
 * @file health-monitor.js
 * @description Tracks disconnects, forbidden errors, logouts, and failed
 *   messages to compute a ban-risk score with actionable recommendations.
 * @author Denzy ZeroDay
 */

const default_config = {
    disconnect_warning_threshold: 3,
    disconnect_critical_threshold: 5,
    failed_message_threshold: 5,
    auto_pause_at: 'high'
}

class health_monitor {
    constructor(config = {}) {
        this.config = { ...default_config, ...config }
        this.events = []
        this.start_time = Date.now()
        this.paused = false
        this.last_risk = 'low'
        this.last_bad_event_time = Date.now()
        this.last_event_was_severe = false
    }

    /** Record a disconnection event */
    record_disconnect(reason) {
        const reason_str = String(reason)
        if (reason_str === '403' || reason_str === 'forbidden') {
            this.events.push({ type: 'forbidden', timestamp: Date.now(), detail: reason_str })
            this.last_bad_event_time = Date.now()
            this.last_event_was_severe = true
        } else if (reason_str === '401' || reason_str === 'loggedOut') {
            this.events.push({ type: 'loggedOut', timestamp: Date.now(), detail: reason_str })
            this.last_bad_event_time = Date.now()
            this.last_event_was_severe = true
        } else if (reason_str === '463') {
            this.events.push({
                type: 'reachoutTimelocked',
                timestamp: Date.now(),
                detail: reason_str
            })
            this.last_bad_event_time = Date.now()
            this.last_event_was_severe = false
        } else {
            this.events.push({ type: 'disconnect', timestamp: Date.now(), detail: reason_str })
            this.last_bad_event_time = Date.now()
            this.last_event_was_severe = false
        }
        this._check_and_notify()
    }

    /** Record a successful reconnection */
    record_reconnect() {
        this.events.push({ type: 'reconnect', timestamp: Date.now() })
    }

    /** Record a failed message send */
    record_message_failed(error) {
        this.events.push({ type: 'messageFailed', timestamp: Date.now(), detail: error })
        this.last_bad_event_time = Date.now()
        this.last_event_was_severe = false
        this._check_and_notify()
    }

    /** Record a 463 reachout timelock error */
    record_reachout_timelock(detail) {
        this.events.push({ type: 'reachoutTimelocked', timestamp: Date.now(), detail })
        this.last_bad_event_time = Date.now()
        this.last_event_was_severe = false
        this._check_and_notify()
    }

    /** Get current health status with ban-risk score and recommendation */
    get_status() {
        const now = Date.now()
        this._cleanup(now)

        const hour_events = this.events.filter((e) => now - e.timestamp < 3600000)
        const disconnects = hour_events.filter((e) => e.type === 'disconnect').length
        const forbidden = hour_events.filter((e) => e.type === 'forbidden').length
        const logged_out = hour_events.filter((e) => e.type === 'loggedOut').length
        const failed_messages = hour_events.filter((e) => e.type === 'messageFailed').length
        const timelocked = hour_events.filter((e) => e.type === 'reachoutTimelocked').length

        let score = 0
        const reasons = []

        if (forbidden > 0) {
            score += 40 * forbidden
            reasons.push(
                `${forbidden} forbidden (403) error${forbidden > 1 ? 's' : ''} in last hour`
            )
        }
        if (logged_out > 0) {
            score += 60
            reasons.push('Logged out by WhatsApp — possible temporary ban')
        }
        if (timelocked > 0) {
            score += 25
            reasons.push(
                `${timelocked} reachout timelock (463) error${timelocked > 1 ? 's' : ''} in last hour`
            )
        }
        if (disconnects >= this.config.disconnect_critical_threshold) {
            score += 30
            reasons.push(`${disconnects} disconnects in last hour (critical threshold)`)
        } else if (disconnects >= this.config.disconnect_warning_threshold) {
            score += 30
            reasons.push(`${disconnects} disconnects in last hour`)
        }
        if (failed_messages >= this.config.failed_message_threshold) {
            score += 20
            reasons.push(`${failed_messages} failed messages in last hour`)
        }

        score = Math.min(100, score)
        const minutes_since_last_bad = (now - this.last_bad_event_time) / 60000
        const decay_rate = this.last_event_was_severe ? 2 : 5
        score = Math.max(0, score - Math.floor(minutes_since_last_bad * decay_rate))

        let risk
        if (score >= 80) risk = 'critical'
        else if (score >= 40) risk = 'high'
        else if (score >= 15) risk = 'medium'
        else risk = 'low'

        let recommendation
        switch (risk) {
            case 'critical':
                recommendation =
                    'STOP ALL MESSAGING IMMEDIATELY. Disconnect and wait 24-48 hours before reconnecting.'
                break
            case 'high':
                recommendation = 'Reduce messaging rate by 80%. Consider pausing for 1-2 hours.'
                break
            case 'medium':
                recommendation = 'Reduce messaging rate by 50%. Increase delays between messages.'
                break
            default:
                recommendation = 'Operating normally. Continue monitoring.'
        }

        const last_disconnect = [...this.events]
            .reverse()
            .find(
                (e) => e.type === 'disconnect' || e.type === 'forbidden' || e.type === 'loggedOut'
            )

        return {
            risk,
            score,
            reasons: reasons.length ? reasons : ['No issues detected'],
            recommendation,
            stats: {
                disconnectsLastHour: disconnects,
                failedMessagesLastHour: failed_messages,
                forbiddenErrors: forbidden,
                timelockErrors: timelocked,
                uptimeMs: now - this.start_time,
                lastDisconnectReason: last_disconnect?.detail
            }
        }
    }

    /** Check if sending should be paused based on current risk */
    is_paused() {
        if (this.paused) return true
        const status = this.get_status()
        const risk_order = ['low', 'medium', 'high', 'critical']
        return risk_order.indexOf(status.risk) >= risk_order.indexOf(this.config.auto_pause_at)
    }

    /** Manually pause/resume sending */
    set_paused(paused) {
        this.paused = paused
    }

    /** Reset all tracked events */
    reset() {
        this.events = []
        this.start_time = Date.now()
        this.paused = false
        this.last_risk = 'low'
        this.last_bad_event_time = Date.now()
        this.last_event_was_severe = false
    }

    _cleanup(now) {
        this.events = this.events.filter((e) => now - e.timestamp < 21600000)
    }

    _check_and_notify() {
        const status = this.get_status()
        if (status.risk !== this.last_risk) {
            this.last_risk = status.risk
            this.config.onRiskChange?.(status)
        }
    }
}

exports.health_monitor = health_monitor
module.exports = { health_monitor }
