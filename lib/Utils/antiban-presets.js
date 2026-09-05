"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
exports.resolve_antiban_config = exports.antiban_presets = void 0

/**
 * @file antiban-presets.js
 * @description Predefined anti-ban configuration presets — conservative
 *   (safest, slowest), moderate (balanced), aggressive (fastest, riskier).
 *   `resolve_antiban_config` accepts a preset name, an object with a
 *   `preset` key plus overrides, or nothing (defaults to conservative).
 * @author Denzy ZeroDay
 */

const antiban_presets = {
    conservative: {
        maxPerMinute: 5,
        maxPerHour: 100,
        maxPerDay: 800,
        minDelayMs: 2500,
        maxDelayMs: 7000,
        newChatDelayMs: 4000,
        warmupDays: 10,
        day1Limit: 15,
        growthFactor: 1.8,
        inactivityThresholdHours: 72,
        autoPauseAt: 'medium',
        groupMultiplier: 0.5,
        groupProfiles: false,
        logging: true
    },
    moderate: {
        maxPerMinute: 10,
        maxPerHour: 300,
        maxPerDay: 1500,
        minDelayMs: 1500,
        maxDelayMs: 5000,
        newChatDelayMs: 3000,
        warmupDays: 7,
        day1Limit: 20,
        growthFactor: 1.8,
        inactivityThresholdHours: 72,
        autoPauseAt: 'high',
        groupMultiplier: 0.7,
        groupProfiles: false,
        logging: true
    },
    aggressive: {
        maxPerMinute: 20,
        maxPerHour: 800,
        maxPerDay: 4000,
        minDelayMs: 800,
        maxDelayMs: 3000,
        newChatDelayMs: 2000,
        warmupDays: 4,
        day1Limit: 35,
        growthFactor: 2,
        inactivityThresholdHours: 48,
        autoPauseAt: 'critical',
        groupMultiplier: 0.9,
        groupProfiles: false,
        logging: true
    }
}
exports.antiban_presets = antiban_presets

/**
 * Resolve an anti-ban config from a preset name, an object with overrides,
 * or nothing (defaults to 'conservative').
 *
 * @param {string|object|undefined} input
 * @returns {object} resolved config
 */
function resolve_antiban_config(input) {
    if (input === undefined) {
        return { ...antiban_presets.conservative }
    }
    if (typeof input === 'string') {
        if (!(input in antiban_presets)) {
            throw new Error(`Unknown preset "${input}". Valid: ${Object.keys(antiban_presets).join(', ')}`)
        }
        return { ...antiban_presets[input] }
    }
    const { preset = 'conservative', ...overrides } = input
    if (!(preset in antiban_presets)) {
        throw new Error(`Unknown preset "${preset}". Valid: ${Object.keys(antiban_presets).join(', ')}`)
    }
    return { ...antiban_presets[preset], ...overrides }
}
exports.resolve_antiban_config = resolve_antiban_config

module.exports = { antiban_presets, resolve_antiban_config }