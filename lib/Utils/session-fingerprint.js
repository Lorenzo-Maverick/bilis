'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.createStealthFingerprint =
    exports.getBatteryState =
    exports.getVoiceNoteMetadata =
    exports.getRetryJitter =
    exports.getTypingJitter =
    exports.getMessageSendJitter =
    exports.applySessionFingerprint =
    exports.generateSessionFingerprint =
        void 0

/**
 * @file session-fingerprint.js
 * @description Per-session fingerprint randomization (Obscura-inspired).
 *   Comprehensive anti-detection: device profile, network timing, voice note
 *   metadata, connection state, and protocol version variance.
 *   Ported from baileys-antiban to CJS for bilis.
 * @author Denzy ZeroDay (port), Kobus Wentzel (original)
 */

const { generateFingerprint } = require('./device-fingerprint')

const DEFAULT_SEND_JITTER_MS = [50, 300]
const DEFAULT_TYPING_JITTER_MS = [30, 150]
const DEFAULT_RETRY_JITTER_MS = [100, 500]
const DEFAULT_DURATION_JITTER_MS = 200
const DEFAULT_SAMPLE_RATE_POOL = [8000, 16000, 44100, 48000]
const DEFAULT_IDLE_TIMEOUT_JITTER_MS = [25000, 35000]
const DEFAULT_KEEPALIVE_JITTER_MS = [15000, 25000]
const DEFAULT_BATTERY_LEVEL_POOL = [20, 35, 50, 65, 80, 95, 100]
const DEFAULT_PROTOCOL_VERSION_POOL = ['2.24.5', '2.24.4', '2.24.3']

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

    range(min, max) {
        return Math.floor(this.next() * (max - min + 1)) + min
    }
    rangeFloat(min, max) {
        return this.next() * (max - min) + min
    }
    pick(array) {
        return array[Math.floor(this.next() * array.length)]
    }
    boolean(probability = 0.5) {
        return this.next() < probability
    }
}

const generateSessionFingerprint = (config = {}, sessionId) => {
    const {
        enabled = true,
        deviceProfile = {},
        networkTiming = {},
        voiceNote = {},
        connectionState = {},
        protocolVersion = {},
        seed
    } = config

    const finalSessionId = sessionId || `session-${Date.now()}-${Math.random()}`
    const rng = new SeededRandom(seed || finalSessionId)

    const device = generateFingerprint(
        {
            enabled,
            randomizeAppVersion: deviceProfile.randomizeAppVersion ?? true,
            randomizeOsVersion: deviceProfile.randomizeOsVersion ?? true,
            randomizeDeviceModel: deviceProfile.randomizeDeviceModel ?? true,
            seed: seed || finalSessionId,
            appVersionPool: deviceProfile.appVersionPool,
            osVersionPool: deviceProfile.osVersionPool,
            deviceModelPool: deviceProfile.deviceModelPool
        },
        finalSessionId
    )

    const sendJitterRange = networkTiming.sendJitterMs || DEFAULT_SEND_JITTER_MS
    const typingJitterRange = networkTiming.typingJitterMs || DEFAULT_TYPING_JITTER_MS
    const retryJitterRange = networkTiming.retryJitterMs || DEFAULT_RETRY_JITTER_MS

    const networkTimingProfile = enabled
        ? {
              sendJitterMs: rng.range(sendJitterRange[0], sendJitterRange[1]),
              typingJitterMs: rng.range(typingJitterRange[0], typingJitterRange[1]),
              retryJitterMs: rng.range(retryJitterRange[0], retryJitterRange[1])
          }
        : { sendJitterMs: 0, typingJitterMs: 0, retryJitterMs: 0 }

    const sampleRatePool = voiceNote.sampleRatePool || DEFAULT_SAMPLE_RATE_POOL
    const voiceNoteProfile = {
        waveformSeed: enabled ? rng.range(0, 2147483647) : 0,
        durationJitterMs:
            enabled && voiceNote.randomizeWaveform !== false
                ? rng.range(0, voiceNote.durationJitterMs || DEFAULT_DURATION_JITTER_MS)
                : 0,
        sampleRate: enabled ? rng.pick(sampleRatePool) : sampleRatePool[0]
    }

    const idleTimeoutRange = connectionState.idleTimeoutJitterMs || DEFAULT_IDLE_TIMEOUT_JITTER_MS
    const keepaliveRange = connectionState.keepaliveJitterMs || DEFAULT_KEEPALIVE_JITTER_MS
    const batteryLevelPool = connectionState.batteryLevelPool || DEFAULT_BATTERY_LEVEL_POOL

    const connectionStateProfile = {
        idleTimeoutMs: enabled ? rng.range(idleTimeoutRange[0], idleTimeoutRange[1]) : 30000,
        keepaliveMs: enabled ? rng.range(keepaliveRange[0], keepaliveRange[1]) : 20000,
        batteryLevel:
            enabled && connectionState.randomizeBattery !== false
                ? rng.pick(batteryLevelPool)
                : 100,
        batteryCharging: enabled ? rng.boolean(0.3) : false
    }

    const versionPool = protocolVersion.versionPool || DEFAULT_PROTOCOL_VERSION_POOL
    const protocolVersionStr =
        enabled && protocolVersion.randomizeSubVersion !== false
            ? rng.pick(versionPool)
            : versionPool[0]

    return {
        device,
        networkTiming: networkTimingProfile,
        voiceNote: voiceNoteProfile,
        connectionState: connectionStateProfile,
        protocolVersion: protocolVersionStr,
        sessionId: finalSessionId,
        createdAt: Date.now()
    }
}
exports.generateSessionFingerprint = generateSessionFingerprint

const applySessionFingerprint = (socketConfig, fingerprint) => {
    const config = { ...socketConfig }
    config.version = fingerprint.device.appVersion
    config.browser = [
        fingerprint.device.deviceModel,
        fingerprint.device.osVersion,
        `WhatsApp/${fingerprint.device.appVersion.join('.')}`
    ]
    if (config.connectTimeoutMs !== undefined)
        config.connectTimeoutMs = fingerprint.connectionState.idleTimeoutMs
    if (config.keepAliveIntervalMs !== undefined)
        config.keepAliveIntervalMs = fingerprint.connectionState.keepaliveMs
    config.__sessionFingerprint = fingerprint
    return config
}
exports.applySessionFingerprint = applySessionFingerprint

const getMessageSendJitter = (fingerprint) => {
    const base = fingerprint.networkTiming.sendJitterMs
    return Math.floor(base * 0.5 + Math.random() * base * 0.5)
}
exports.getMessageSendJitter = getMessageSendJitter

const getTypingJitter = (fingerprint) => {
    const base = fingerprint.networkTiming.typingJitterMs
    return Math.floor(base * 0.5 + Math.random() * base * 0.5)
}
exports.getTypingJitter = getTypingJitter

const getRetryJitter = (fingerprint) => {
    const base = fingerprint.networkTiming.retryJitterMs
    return Math.floor(base * 0.5 + Math.random() * base * 0.5)
}
exports.getRetryJitter = getRetryJitter

const getVoiceNoteMetadata = (fingerprint) => ({
    sampleRate: fingerprint.voiceNote.sampleRate,
    durationJitterMs: fingerprint.voiceNote.durationJitterMs,
    waveformSeed: fingerprint.voiceNote.waveformSeed
})
exports.getVoiceNoteMetadata = getVoiceNoteMetadata

const getBatteryState = (fingerprint) => ({
    level: fingerprint.connectionState.batteryLevel,
    charging: fingerprint.connectionState.batteryCharging
})
exports.getBatteryState = getBatteryState

const createStealthFingerprint = (sessionId) =>
    generateSessionFingerprint(
        {
            enabled: true,
            deviceProfile: {
                randomizeAppVersion: true,
                randomizeOsVersion: true,
                randomizeDeviceModel: true
            },
            networkTiming: {
                sendJitterMs: [100, 500],
                typingJitterMs: [50, 200],
                retryJitterMs: [200, 800]
            },
            voiceNote: { randomizeWaveform: true, durationJitterMs: 300 },
            connectionState: { randomizeBattery: true },
            protocolVersion: { randomizeSubVersion: true }
        },
        sessionId
    )
exports.createStealthFingerprint = createStealthFingerprint

module.exports = {
    generateSessionFingerprint,
    applySessionFingerprint,
    getMessageSendJitter,
    getTypingJitter,
    getRetryJitter,
    getVoiceNoteMetadata,
    getBatteryState,
    createStealthFingerprint
}
