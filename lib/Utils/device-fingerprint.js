'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.applyFingerprint = exports.generateFingerprint = void 0

/**
 * @file device-fingerprint.js
 * @description Device fingerprint randomization for WhatsApp connections.
 *   Randomizes appVersion, osVersion, and deviceModel to prevent Meta's
 *   clientPayload fingerprinting — addresses the #1 gap in anti-ban coverage.
 *   Ported from baileys-antiban to CJS for bilis.
 * @author Denzy ZeroDay (port), Kobus Wentzel (original)
 */

const DEFAULT_APP_VERSION_POOL = [
    [2, 24, 5, 18],
    [2, 24, 5, 17],
    [2, 24, 4, 77],
    [2, 24, 5, 15],
    [2, 24, 3, 91],
    [2, 24, 5, 20]
]

const DEFAULT_OS_VERSION_POOL = ['10', '11', '12', '13', '14']

const DEFAULT_DEVICE_MODEL_POOL = [
    'Pixel 6',
    'Pixel 7',
    'Galaxy S22',
    'Galaxy S23',
    'Xiaomi 13',
    'Xiaomi 12',
    'OnePlus 11',
    'Moto G84',
    'Moto G54',
    'Realme 11',
    'Vivo V29',
    'Oppo Find X6'
]

/** Simple deterministic PRNG using mulberry32, seeded from string hash */
class SeededRandom {
    constructor(seed) {
        let hash = 0
        for (let i = 0; i < seed.length; i++) {
            hash = (hash << 5) - hash + seed.charCodeAt(i)
            hash = hash & hash
        }
        this.state = Math.abs(hash) || 1
    }

    next() {
        let t = (this.state += 0x6d2b79f5)
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }

    pick(array) {
        return array[Math.floor(this.next() * array.length)]
    }
}

/**
 * Generate a randomized device fingerprint for one session.
 * Stable for the same sessionId — call once per socket init.
 *
 * @param {object} config - Optional config
 * @param {boolean} config.enabled - Master switch (default: true)
 * @param {boolean} config.randomizeAppVersion - Vary app version (default: true)
 * @param {boolean} config.randomizeOsVersion - Vary OS version (default: true)
 * @param {boolean} config.randomizeDeviceModel - Pick random device (default: true)
 * @param {string}  config.seed - Optional seed for deterministic results
 * @param {Array}   config.appVersionPool - Custom app version pool
 * @param {Array}   config.osVersionPool - Custom OS version pool
 * @param {Array}   config.deviceModelPool - Custom device model pool
 * @param {string}  sessionId - Optional session ID for stable results
 * @returns {{ appVersion, osVersion, deviceModel, sessionId }}
 */
const generateFingerprint = (config = {}, sessionId) => {
    const {
        enabled = true,
        randomizeAppVersion = true,
        randomizeOsVersion = true,
        randomizeDeviceModel = true,
        seed,
        appVersionPool = DEFAULT_APP_VERSION_POOL,
        osVersionPool = DEFAULT_OS_VERSION_POOL,
        deviceModelPool = DEFAULT_DEVICE_MODEL_POOL
    } = config

    const finalSessionId = sessionId || `session-${Date.now()}-${Math.random()}`
    const rng = new SeededRandom(seed || finalSessionId)

    const appVersion = enabled && randomizeAppVersion ? rng.pick(appVersionPool) : appVersionPool[0]

    const osVersion = enabled && randomizeOsVersion ? rng.pick(osVersionPool) : osVersionPool[0]

    const deviceModel =
        enabled && randomizeDeviceModel ? rng.pick(deviceModelPool) : deviceModelPool[0]

    return {
        appVersion: [...appVersion],
        osVersion,
        deviceModel,
        sessionId: finalSessionId
    }
}
exports.generateFingerprint = generateFingerprint

/**
 * Apply fingerprint to a Baileys SocketConfig before makeWASocket().
 *
 * @example
 * const fp = generateFingerprint({})
 * const sock = makeWASocket(applyFingerprint(config, fp))
 *
 * @param {object} socketConfig - Baileys socket config
 * @param {{ appVersion, osVersion, deviceModel }} fp - Fingerprint from generateFingerprint()
 * @returns {object} Modified socket config
 */
const applyFingerprint = (socketConfig, fp) => {
    const config = { ...socketConfig }
    config.version = fp.appVersion
    config.browser = [fp.deviceModel, fp.osVersion, `WhatsApp/${fp.appVersion.join('.')}`]
    return config
}
exports.applyFingerprint = applyFingerprint

module.exports = {
    generateFingerprint,
    applyFingerprint,
    DEFAULT_APP_VERSION_POOL,
    DEFAULT_OS_VERSION_POOL,
    DEFAULT_DEVICE_MODEL_POOL
}
