"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
exports.HumanEntropyService = exports.createHumanEntropyService = void 0

/**
 * @file human-entropy.js
 * @description Background noise for WA sessions — fake human activity
 *   to prevent bot detection. Performs random typing presence, delayed
 *   read receipts, and availability status toggles periodically.
 *   Ported from baileys-antiban to CJS for bilis.
 * @author Denzy ZeroDay (port), original by baileys-antiban contributors
 */

const DEFAULT_CONFIG = {
    enabled: true,
    minIntervalMs: 2 * 60 * 60 * 1000,   // 2 hours
    maxIntervalMs: 6 * 60 * 60 * 1000,   // 6 hours
    maxRecentContacts: 30,
    typingProbability: 0.3,
    typingMinMs: 3000,
    typingMaxMs: 8000,
    readReceiptProbability: 0.2,
    readReceiptMinDelayMs: 10 * 60 * 1000, // 10 min
    readReceiptMaxDelayMs: 60 * 60 * 1000, // 60 min
    presenceToggleProbability: 0.15,
    presenceToggleMinMs: 30 * 1000,       // 30 sec
    presenceToggleMaxMs: 2 * 60 * 1000    // 2 min
}

class HumanEntropyService {
    /**
     * @param {object} sock - Baileys WASocket instance
     * @param {object} config - Optional config overrides
     */
    constructor(sock, config = {}) {
        this.sock = sock
        this.config = { ...DEFAULT_CONFIG, ...config }
        this.recentContacts = []
        this.unreadMessages = []
        this.cycleTimer = null
        this.isRunning = false
        this.stats = {
            cyclesExecuted: 0,
            typingActionsPerformed: 0,
            readReceiptsMarked: 0,
            presenceToggles: 0,
            errors: 0,
            lastCycleAt: null,
            nextCycleAt: null
        }
    }

    /**
     * Start the entropy service.
     * Call this after sock is connected.
     */
    start() {
        if (!this.config.enabled) return
        if (this.isRunning) return
        this.isRunning = true
        this._scheduleNextCycle()
    }

    /**
     * Stop the entropy service.
     */
    stop() {
        this.isRunning = false
        if (this.cycleTimer) {
            clearTimeout(this.cycleTimer)
            this.cycleTimer = null
        }
        this.stats.nextCycleAt = null
    }

    /**
     * Track an incoming message to build recent contacts list.
     * Call this from messages.upsert event handler.
     * @param {object} msg - Raw Baileys message
     */
    trackMessage(msg) {
        try {
            if (msg.key?.fromMe) return
            const jid = msg.key?.remoteJid
            if (!jid) return

            const isGroup = jid.endsWith('@g.us')
            const existingIdx = this.recentContacts.findIndex(c => c.jid === jid)

            if (existingIdx >= 0) {
                this.recentContacts[existingIdx].lastMessageAt = new Date()
            } else {
                this.recentContacts.push({ jid, lastMessageAt: new Date(), isGroup })
            }

            if (this.recentContacts.length > this.config.maxRecentContacts) {
                this.recentContacts.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
                this.recentContacts = this.recentContacts.slice(0, this.config.maxRecentContacts)
            }

            if (msg.key?.id && msg.message) {
                this.unreadMessages.push({ jid, messageKey: msg.key, receivedAt: new Date() })
                if (this.unreadMessages.length > 50) {
                    this.unreadMessages = this.unreadMessages.slice(-50)
                }
            }
        } catch (err) {
            this.stats.errors++
        }
    }

    /**
     * Get current stats
     */
    getStats() {
        return { ...this.stats }
    }

    _scheduleNextCycle() {
        if (!this.isRunning) return
        const delay = this._rand(this.config.minIntervalMs, this.config.maxIntervalMs)
        this.stats.nextCycleAt = new Date(Date.now() + delay)
        this.cycleTimer = setTimeout(() => {
            this._executeCycle()
                .catch(() => this.stats.errors++)
                .finally(() => this._scheduleNextCycle())
        }, delay)
    }

    async _executeCycle() {
        if (!this.isRunning || this.recentContacts.length === 0) return

        this.stats.cyclesExecuted++
        this.stats.lastCycleAt = new Date()

        const actions = []

        if (Math.random() < this.config.typingProbability) {
            actions.push(this._performTyping())
        }
        if (Math.random() < this.config.readReceiptProbability && this.unreadMessages.length > 0) {
            actions.push(this._performReadReceipt())
        }
        if (Math.random() < this.config.presenceToggleProbability) {
            actions.push(this._performPresenceToggle())
        }

        await Promise.allSettled(actions)
    }

    async _performTyping() {
        try {
            const eligible = this.recentContacts.filter(c => !c.isGroup)
            if (eligible.length === 0) return
            const contact = eligible[Math.floor(Math.random() * eligible.length)]
            const duration = this._rand(this.config.typingMinMs, this.config.typingMaxMs)

            await this.sock.sendPresenceUpdate('composing', contact.jid)
            await this._sleep(duration)
            await this.sock.sendPresenceUpdate('paused', contact.jid)

            this.stats.typingActionsPerformed++
        } catch (err) {
            this.stats.errors++
        }
    }

    async _performReadReceipt() {
        try {
            const msg = this.unreadMessages[Math.floor(Math.random() * this.unreadMessages.length)]
            if (!msg) return
            const delay = this._rand(this.config.readReceiptMinDelayMs, this.config.readReceiptMaxDelayMs)
            await this._sleep(delay)
            await this.sock.readMessages([msg.messageKey])
            this.unreadMessages = this.unreadMessages.filter(m => m !== msg)
            this.stats.readReceiptsMarked++
        } catch (err) {
            this.stats.errors++
        }
    }

    async _performPresenceToggle() {
        try {
            const duration = this._rand(this.config.presenceToggleMinMs, this.config.presenceToggleMaxMs)
            await this.sock.sendPresenceUpdate('available')
            await this._sleep(duration)
            await this.sock.sendPresenceUpdate('unavailable')
            this.stats.presenceToggles++
        } catch (err) {
            this.stats.errors++
        }
    }

    _rand(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

/**
 * Factory function
 * @param {object} sock - Baileys WASocket
 * @param {object} config - Optional config
 */
const createHumanEntropyService = (sock, config = {}) => {
    const service = new HumanEntropyService(sock, config)
    return {
        start: () => service.start(),
        stop: () => service.stop(),
        trackMessage: (msg) => service.trackMessage(msg),
        getStats: () => service.getStats()
    }
}

exports.HumanEntropyService = HumanEntropyService
exports.createHumanEntropyService = createHumanEntropyService
module.exports = { HumanEntropyService, createHumanEntropyService }