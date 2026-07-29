'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.rampPresenceAfterConnect =
    exports.getStealthSocketConfig =
    exports.AbortError =
    exports.STEALTH_BROWSER_POOL =
        void 0

/**
 * @file stealth-connect.js
 * @description Reduce ban signal on socket connect + presence ramp.
 *   Inspired by GOWA's --presence-on-connect=unavailable flag.
 *   Bots that snap online immediately and start blasting messages look
 *   suspicious to WA's anti-spam classifier.
 *
 *   - getStealthSocketConfig() — disables markOnlineOnConnect, randomizes browser fingerprint
 *   - rampPresenceAfterConnect() — waits random delay then sets presence to available
 *
 *   Usage:
 *     const { getStealthSocketConfig, rampPresenceAfterConnect } = require('@whiskeysockets/baileys')
 *     const sock = makeWASocket({ ...getStealthSocketConfig(), auth: state })
 *     await rampPresenceAfterConnect(sock)
 *
 *   Ported from baileys-antiban to CJS for bilis.
 * @author Denzy ZeroDay (port), Kobus Wentzel (original)
 */

const STEALTH_BROWSER_POOL = Object.freeze([
    ['Mac OS', 'Chrome', '120.0.6099.109'],
    ['Mac OS', 'Safari', '17.2.1'],
    ['Windows', 'Chrome', '121.0.6167.85'],
    ['Windows', 'Firefox', '122.0'],
    ['Windows', 'Edge', '120.0.2210.144'],
    ['Linux', 'Chrome', '120.0.6099.109'],
    ['Linux', 'Firefox', '122.0'],
    ['Ubuntu', 'Chrome', '121.0.6167.85']
])
exports.STEALTH_BROWSER_POOL = STEALTH_BROWSER_POOL

class AbortError extends Error {
    constructor(message = 'rampPresenceAfterConnect aborted') {
        super(message)
        this.name = 'AbortError'
    }
}
exports.AbortError = AbortError

/**
 * Returns a partial Baileys socket config tuned for stealth connect.
 * - markOnlineOnConnect: false — joins without broadcasting 'available'
 * - browser: randomized realistic tuple from STEALTH_BROWSER_POOL
 *
 * @param {object} opts
 * @param {string} opts.os - Override OS name slot
 * @param {Array} opts.browser - Explicit browser tuple [os, browser, version]
 * @param {function} opts.random - Custom RNG (default: Math.random)
 * @returns {{ markOnlineOnConnect: boolean, browser: Array }}
 */
const getStealthSocketConfig = (opts = {}) => {
    const random = opts.random ?? Math.random
    let browser

    if (opts.browser) {
        browser = opts.browser
    } else {
        const pick = STEALTH_BROWSER_POOL[Math.floor(random() * STEALTH_BROWSER_POOL.length)]
        browser = opts.os ? [opts.os, pick[1], pick[2]] : [...pick]
    }

    return {
        markOnlineOnConnect: false,
        browser
    }
}
exports.getStealthSocketConfig = getStealthSocketConfig

/**
 * Waits a randomized delay then calls sock.sendPresenceUpdate(targetState).
 * Supports AbortSignal — abort during delay cancels timer and rejects with AbortError.
 *
 * @param {object} sock - Baileys WASocket (needs sendPresenceUpdate)
 * @param {object} opts
 * @param {number} opts.minDelayMs - Min delay ms (default: 30000)
 * @param {number} opts.maxDelayMs - Max delay ms (default: 90000)
 * @param {string} opts.targetState - Presence state (default: 'available')
 * @param {AbortSignal} opts.signal - Optional AbortSignal to cancel
 * @param {function} opts.random - Custom RNG
 */
const rampPresenceAfterConnect = async (sock, opts = {}) => {
    const minDelayMs = opts.minDelayMs ?? 30000
    const maxDelayMs = opts.maxDelayMs ?? 90000
    const targetState = opts.targetState ?? 'available'
    const random = opts.random ?? Math.random
    const signal = opts.signal

    if (signal?.aborted) throw new AbortError()

    const range = Math.max(0, maxDelayMs - minDelayMs)
    const delayMs = Math.floor(random() * (range + 1)) + minDelayMs

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort)
            resolve()
        }, delayMs)

        const onAbort = () => {
            clearTimeout(timer)
            reject(new AbortError())
        }

        if (signal) signal.addEventListener('abort', onAbort, { once: true })
    })

    await sock.sendPresenceUpdate(targetState, undefined)
}
exports.rampPresenceAfterConnect = rampPresenceAfterConnect

module.exports = {
    STEALTH_BROWSER_POOL,
    AbortError,
    getStealthSocketConfig,
    rampPresenceAfterConnect
}
