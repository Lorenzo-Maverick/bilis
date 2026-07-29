'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.LegitimacySignalInjector = void 0

/**
 * @file legitimacy-signal-injector.js
 * @description Injects human imperfection signals into WA messages.
 *   WA detection looks for TOO perfect accounts: no typos, consistent
 *   reply speeds, typing duration linearly correlated with message length.
 *   This module injects realistic imperfections:
 *     - Typos followed by corrections (2.5% of messages)
 *     - Read-receipt without immediate reply (read gap)
 *     - Mid-typing pauses for longer messages
 *   Ported from baileys-antiban to CJS for bilis.
 * @author Denzy ZeroDay (port), Kobus Wentzel (original)
 */

const QWERTY_ADJACENT = {
    a: ['q', 's', 'w', 'z'],
    b: ['v', 'g', 'h', 'n'],
    c: ['x', 'd', 'f', 'v'],
    d: ['s', 'e', 'r', 'f', 'c', 'x'],
    e: ['w', 'r', 'd', 's'],
    f: ['d', 'r', 't', 'g', 'v', 'c'],
    g: ['f', 't', 'y', 'h', 'b', 'v'],
    h: ['g', 'y', 'u', 'j', 'n', 'b'],
    i: ['u', 'o', 'k', 'j'],
    j: ['h', 'u', 'i', 'k', 'n', 'm'],
    k: ['j', 'i', 'o', 'l', 'm'],
    l: ['k', 'o', 'p'],
    m: ['n', 'j', 'k'],
    n: ['b', 'h', 'j', 'm'],
    o: ['i', 'p', 'l', 'k'],
    p: ['o', 'l'],
    q: ['w', 'a'],
    r: ['e', 't', 'f', 'd'],
    s: ['a', 'w', 'e', 'd', 'x', 'z'],
    t: ['r', 'y', 'g', 'f'],
    u: ['y', 'i', 'j', 'h'],
    v: ['c', 'f', 'g', 'b'],
    w: ['q', 'e', 's', 'a'],
    x: ['z', 's', 'd', 'c'],
    y: ['t', 'u', 'h', 'g'],
    z: ['a', 's', 'x']
}

const DEFAULT_CONFIG = {
    enableTypos: true,
    typoProbability: 0.025,
    typoCorrectMinMs: 500,
    typoCorrectMaxMs: 2000,
    enableReadGaps: true,
    readGapProbability: 0.15,
    readGapMinMs: 300000,
    readGapMaxMs: 3600000,
    enableTypingPauses: true,
    typingPauseLengthThreshold: 50,
    typingPauseProbability: 0.4,
    typingPauseMinMs: 1500,
    typingPauseMaxMs: 6000
}

class LegitimacySignalInjector {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config }
        this.stats = {
            typosInjected: 0,
            correctionsGenerated: 0,
            readGapsInjected: 0,
            typingPausesInjected: 0
        }
    }

    /**
     * Check if a typo should be injected for this message.
     * Returns { typoText, correctionDelay, correctionText } or null.
     */
    shouldInjectTypo(text) {
        if (!this.config.enableTypos || text.length <= 10) return null
        if (Math.random() >= this.config.typoProbability) return null
        if (/https?:\/\/|www\./i.test(text)) return null

        const words = text.split(/\s+/)
        const eligible = words.filter(
            (w) => w.length >= 3 && !w.startsWith('@') && !/^\d+$/.test(w)
        )
        if (eligible.length === 0) return null

        const targetWord = eligible[Math.floor(Math.random() * eligible.length)]
        const typoWord = this._injectTypoInWord(targetWord)
        if (!typoWord || typoWord === targetWord) return null

        const typoText = text.replace(targetWord, typoWord)
        const correctionDelay = this._rand(
            this.config.typoCorrectMinMs,
            this.config.typoCorrectMaxMs
        )
        const correctionText = text.length < 30 ? text : `*${targetWord}`

        this.stats.typosInjected++
        this.stats.correctionsGenerated++

        return { typoText, correctionDelay, correctionText }
    }

    /**
     * Check if a read gap should be injected before replying.
     * Returns gap duration in ms, or null.
     */
    shouldInjectReadGap() {
        if (!this.config.enableReadGaps) return null
        if (Math.random() >= this.config.readGapProbability) return null
        const gapMs = this._rand(this.config.readGapMinMs, this.config.readGapMaxMs)
        this.stats.readGapsInjected++
        return gapMs
    }

    /**
     * Calculate mid-typing pause positions for long messages.
     * Returns array of { afterChars, pauseDurationMs }.
     */
    getTypingPauses(messageLength) {
        if (!this.config.enableTypingPauses) return []
        if (messageLength < this.config.typingPauseLengthThreshold) return []
        if (Math.random() >= this.config.typingPauseProbability) return []

        const pauses = []
        const numPauses = Math.random() < 0.6 ? 1 : 2

        for (let i = 0; i < numPauses; i++) {
            const pct = i === 0 ? 0.35 + Math.random() * 0.15 : 0.65 + Math.random() * 0.15
            pauses.push({
                afterChars: Math.floor(messageLength * pct),
                pauseDurationMs: this._rand(
                    this.config.typingPauseMinMs,
                    this.config.typingPauseMaxMs
                )
            })
            this.stats.typingPausesInjected++
        }

        return pauses.sort((a, b) => a.afterChars - b.afterChars)
    }

    getStats() {
        return { ...this.stats }
    }

    reset() {
        this.stats = {
            typosInjected: 0,
            correctionsGenerated: 0,
            readGapsInjected: 0,
            typingPausesInjected: 0
        }
    }

    _injectTypoInWord(word) {
        const chars = word.toLowerCase().split('')
        const eligible = chars.map((c, i) => ({ c, i })).filter(({ c }) => QWERTY_ADJACENT[c])
        if (eligible.length === 0) return null

        const target = eligible[Math.floor(Math.random() * eligible.length)]
        const neighbors = QWERTY_ADJACENT[target.c]
        const rep = neighbors[Math.floor(Math.random() * neighbors.length)]
        const orig = word[target.i]
        const repChar = orig === orig.toUpperCase() ? rep.toUpperCase() : rep

        const typo = word.split('')
        typo[target.i] = repChar
        return typo.join('')
    }

    _rand(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }
}

exports.LegitimacySignalInjector = LegitimacySignalInjector
module.exports = { LegitimacySignalInjector, QWERTY_ADJACENT }
