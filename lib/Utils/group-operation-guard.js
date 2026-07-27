"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
exports.GroupOperationGuard = exports.extractPrivacyBlock = exports.classifyGroupOpError = exports.GROUP_OP_ERRORS = void 0

/**
 * @file group-operation-guard.js
 * @description Rate limiting for WhatsApp group operations.
 *   Prevents account_reachout_restricted and rate-overlimit errors
 *   by enforcing per-operation windows on group adds, removes, and creates.
 *
 *   WA unofficial limits (observed):
 *     - groupParticipantsUpdate (add): ~3 new contacts per 10 min
 *     - groupCreate: ~2 per 10 min
 *     - Rapid retries after 403: triggers account_reachout_restricted
 *
 *   Ported from baileys-antiban to CJS for bilis.
 * @author Denzy ZeroDay (port), original by baileys-antiban contributors
 */

const DEFAULT_LIMITS = {
    add:    { max: 3,  windowMs: 10 * 60 * 1000 },  // 3 adds / 10 min
    remove: { max: 5,  windowMs: 10 * 60 * 1000 },  // 5 removes / 10 min
    create: { max: 2,  windowMs: 10 * 60 * 1000 },  // 2 creates / 10 min
    invite: { max: 10, windowMs: 10 * 60 * 1000 },  // 10 invite fetches / 10 min
}

/** Known WA error patterns for group operations */
const GROUP_OP_ERRORS = {
    REACHOUT_RESTRICTED: 'account_reachout_restricted',
    RATE_OVERLIMIT:      'rate-overlimit',
    PRIVACY_BLOCK:       '403',
    INVITE_EXPIRED:      'gone',
    GROUP_LOCKED:        'locked',
}
exports.GROUP_OP_ERRORS = GROUP_OP_ERRORS

/**
 * Classify a caught error from a group operation.
 * @param {unknown} err
 * @returns {string|null}
 */
const classifyGroupOpError = (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('account_reachout_restricted') || msg.includes('reachout')) return GROUP_OP_ERRORS.REACHOUT_RESTRICTED
    if (msg.includes('rate-overlimit') || msg.includes('429'))                    return GROUP_OP_ERRORS.RATE_OVERLIMIT
    if (msg.includes('locked'))                                                   return GROUP_OP_ERRORS.GROUP_LOCKED
    if (msg.includes('gone'))                                                     return GROUP_OP_ERRORS.INVITE_EXPIRED
    return null
}
exports.classifyGroupOpError = classifyGroupOpError

/**
 * Check whether a groupParticipantsUpdate result contains a privacy-block 403
 * with an invite code that should be used instead of direct add.
 * @param {Array} result - Result from sock.groupParticipantsUpdate()
 * @returns {{ blocked: boolean, inviteCode?: string, inviteLink?: string }}
 */
const extractPrivacyBlock = (result) => {
    if (!Array.isArray(result)) return { blocked: false }
    for (const r of result) {
        if (r.status !== '403') continue
        const content = Array.isArray(r.content) ? r.content : []
        for (const c of content) {
            if (c.tag === 'add_request' && typeof c.attrs === 'object' && c.attrs.code) {
                return {
                    blocked: true,
                    inviteCode: c.attrs.code,
                    inviteLink: `https://chat.whatsapp.com/${c.attrs.code}`
                }
            }
        }
        return { blocked: true }
    }
    return { blocked: false }
}
exports.extractPrivacyBlock = extractPrivacyBlock

class GroupOperationGuard {
    /**
     * @param {object} config
     * @param {object} config.limits - Override per-operation limits
     */
    constructor(config = {}) {
        this.limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) }
        this.windows = new Map()
    }

    /**
     * Check whether an operation is allowed under the current rate limits.
     * @param {'add'|'remove'|'create'|'invite'} op - Operation type
     * @param {string} key - Unique key scoping the limit (e.g. groupJid)
     * @returns {{ allowed: boolean, reason?: string, retryAfterSec?: number }}
     */
    check(op, key) {
        const limit = this.limits[op]
        if (!limit) return { allowed: true }
        const windowKey = `${op}:${key}`
        const now = Date.now()
        const entry = this.windows.get(windowKey)

        if (!entry || now > entry.resetAt) {
            this.windows.set(windowKey, { count: 1, resetAt: now + limit.windowMs })
            return { allowed: true }
        }

        if (entry.count >= limit.max) {
            const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000)
            return {
                allowed: false,
                reason: `Too many ${op} attempts — wait ${Math.ceil(retryAfterSec / 60)} min before trying again.`,
                retryAfterSec
            }
        }

        entry.count++
        return { allowed: true }
    }

    /**
     * Reset the counter for a specific operation + key.
     * @param {'add'|'remove'|'create'|'invite'} op
     * @param {string} key
     */
    reset(op, key) {
        this.windows.delete(`${op}:${key}`)
    }

    /**
     * Snapshot of all active windows.
     * @returns {object}
     */
    getStats() {
        const stats = {}
        for (const [key, val] of this.windows) {
            stats[key] = { ...val }
        }
        return stats
    }
}

exports.GroupOperationGuard = GroupOperationGuard
module.exports = { GroupOperationGuard, classifyGroupOpError, extractPrivacyBlock, GROUP_OP_ERRORS }