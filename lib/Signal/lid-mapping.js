'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.LIDMappingStore = void 0

const WABinary_1 = require('../WABinary/jid-utils')

const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 5000

const isPnJid = (jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')
const isLidJid = (jid) => typeof jid === 'string' && jid.endsWith('@lid')

/**
 * Small TTL + size capped cache (keeps this module free of extra dependencies)
 */
class TtlCache {
    constructor(ttl, max) {
        this.ttl = ttl
        this.max = max
        this.map = new Map()
    }
    get(key) {
        const hit = this.map.get(key)
        if (!hit) return undefined
        if (hit.exp < Date.now()) {
            this.map.delete(key)
            return undefined
        }
        hit.exp = Date.now() + this.ttl
        return hit.value
    }
    set(key, value) {
        if (this.map.size >= this.max) {
            const oldest = this.map.keys().next().value
            this.map.delete(oldest)
        }
        this.map.set(key, { value, exp: Date.now() + this.ttl })
    }
    clear() {
        this.map.clear()
    }
}

/**
 * Stores PN <-> LID user mappings in the auth key store ('lid-mapping').
 * Purely additive: nothing in the decode / send / session path depends on it.
 */
class LIDMappingStore {
    /**
     * @param keys SignalKeyStore (with transaction capability)
     * @param logger pino logger
     * @param pnToLIDFunc optional (jids: string[]) => Promise<{ pn, lid }[]> used when a mapping is unknown
     */
    constructor(keys, logger, pnToLIDFunc) {
        this.keys = keys
        this.logger = logger
        this.pnToLIDFunc = pnToLIDFunc
        this.cache = new TtlCache(CACHE_TTL_MS, CACHE_MAX_ENTRIES)
        this.inflightLID = new Map()
        this.inflightPN = new Map()
    }

    /** Store one or more { lid, pn } pairs. Invalid pairs are skipped, never thrown. */
    async storeLIDPNMappings(pairs) {
        if (!Array.isArray(pairs) || pairs.length === 0) return

        const valid = []
        for (const { lid, pn } of pairs) {
            if (!((isLidJid(lid) && isPnJid(pn)) || (isPnJid(lid) && isLidJid(pn)))) {
                this.logger?.warn?.(`Invalid LID-PN mapping: ${lid}, ${pn}`)
                continue
            }
            const lidDecoded = (0, WABinary_1.jidDecode)(isLidJid(lid) ? lid : pn)
            const pnDecoded = (0, WABinary_1.jidDecode)(isPnJid(pn) ? pn : lid)
            if (!lidDecoded || !pnDecoded) continue
            valid.push({ pnUser: pnDecoded.user, lidUser: lidDecoded.user })
        }
        if (valid.length === 0) return

        const missing = []
        const known = new Map()
        for (const { pnUser } of valid) {
            const cached = this.cache.get(`pn:${pnUser}`)
            if (cached) known.set(pnUser, cached)
            else missing.push(pnUser)
        }
        if (missing.length) {
            const stored = await this.keys.get('lid-mapping', [...new Set(missing)])
            for (const pnUser of new Set(missing)) {
                const lidUser = stored?.[pnUser]
                if (lidUser) {
                    known.set(pnUser, lidUser)
                    this.cache.set(`pn:${pnUser}`, lidUser)
                    this.cache.set(`lid:${lidUser}`, pnUser)
                }
            }
        }

        const batch = {}
        const toCache = []
        for (const { pnUser, lidUser } of valid) {
            if (known.get(pnUser) === lidUser) continue
            batch[pnUser] = lidUser
            batch[`${lidUser}_reverse`] = pnUser
            toCache.push([pnUser, lidUser])
        }
        if (Object.keys(batch).length === 0) return

        await this.keys.transaction(async () => {
            await this.keys.set({ 'lid-mapping': batch })
        }, 'lid-mapping')

        for (const [pnUser, lidUser] of toCache) {
            this.cache.set(`pn:${pnUser}`, lidUser)
            this.cache.set(`lid:${lidUser}`, pnUser)
        }
    }

    async getLIDForPN(pn) {
        const res = await this.getLIDsForPNs([pn])
        return (res && res[0] && res[0].lid) || null
    }

    async getLIDsForPNs(pns) {
        if (!Array.isArray(pns) || pns.length === 0) return null
        const cacheKey = [...new Set(pns)].sort().join(',')
        const inflight = this.inflightLID.get(cacheKey)
        if (inflight) return inflight
        const promise = this._getLIDsForPNs(pns)
        this.inflightLID.set(cacheKey, promise)
        try {
            return await promise
        } finally {
            this.inflightLID.delete(cacheKey)
        }
    }

    async _getLIDsForPNs(pns) {
        const out = {}
        const pending = []
        const usyncFetch = new Map()

        const resolve = (pn, decoded, lidUser) => {
            if (!lidUser) return false
            const device = decoded.device ? `:${decoded.device}` : ''
            out[pn] = { lid: `${lidUser}${device}@lid`, pn }
            return true
        }

        for (const pn of pns) {
            if (!isPnJid(pn)) continue
            const decoded = (0, WABinary_1.jidDecode)(pn)
            if (!decoded) continue
            const cached = this.cache.get(`pn:${decoded.user}`)
            if (cached) resolve(pn, decoded, cached)
            else pending.push({ pn, decoded })
        }

        if (pending.length) {
            const users = [...new Set(pending.map((p) => p.decoded.user))]
            const stored = await this.keys.get('lid-mapping', users)
            for (const user of users) {
                const lidUser = stored?.[user]
                if (lidUser && typeof lidUser === 'string') {
                    this.cache.set(`pn:${user}`, lidUser)
                    this.cache.set(`lid:${lidUser}`, user)
                }
            }
            for (const { pn, decoded } of pending) {
                const cached = this.cache.get(`pn:${decoded.user}`)
                if (cached) {
                    resolve(pn, decoded, cached)
                } else {
                    const normalized = (0, WABinary_1.jidNormalizedUser)(pn)
                    if (!usyncFetch.has(normalized)) usyncFetch.set(normalized, [])
                    usyncFetch.get(normalized).push(decoded.device || 0)
                }
            }
        }

        if (usyncFetch.size > 0 && this.pnToLIDFunc) {
            try {
                const result = await this.pnToLIDFunc([...usyncFetch.keys()])
                if (result && result.length) {
                    await this.storeLIDPNMappings(result)
                    for (const pair of result) {
                        const pnDecoded = (0, WABinary_1.jidDecode)(pair.pn)
                        const lidDecoded = (0, WABinary_1.jidDecode)(pair.lid)
                        if (!pnDecoded || !lidDecoded) continue
                        for (const device of usyncFetch.get(pair.pn) || [0]) {
                            const suffix = device ? `:${device}` : ''
                            const pnJid = `${pnDecoded.user}${suffix}@s.whatsapp.net`
                            out[pnJid] = { lid: `${lidDecoded.user}${suffix}@lid`, pn: pnJid }
                        }
                    }
                }
            } catch (err) {
                // lookup is best effort, never break the caller
                this.logger?.warn?.({ err }, 'LID lookup via usync failed')
            }
        }

        const values = Object.values(out)
        return values.length ? values : null
    }

    async getPNForLID(lid) {
        const res = await this.getPNsForLIDs([lid])
        return (res && res[0] && res[0].pn) || null
    }

    async getPNsForLIDs(lids) {
        if (!Array.isArray(lids) || lids.length === 0) return null
        const cacheKey = [...new Set(lids)].sort().join(',')
        const inflight = this.inflightPN.get(cacheKey)
        if (inflight) return inflight
        const promise = this._getPNsForLIDs(lids)
        this.inflightPN.set(cacheKey, promise)
        try {
            return await promise
        } finally {
            this.inflightPN.delete(cacheKey)
        }
    }

    async _getPNsForLIDs(lids) {
        const out = {}
        const pending = []

        const resolve = (lid, decoded, pnUser) => {
            if (!pnUser || typeof pnUser !== 'string') return false
            const device = decoded.device ? `:${decoded.device}` : ''
            out[lid] = { lid, pn: `${pnUser}${device}@s.whatsapp.net` }
            return true
        }

        for (const lid of lids) {
            if (!isLidJid(lid)) continue
            const decoded = (0, WABinary_1.jidDecode)(lid)
            if (!decoded) continue
            const cached = this.cache.get(`lid:${decoded.user}`)
            if (cached) resolve(lid, decoded, cached)
            else pending.push({ lid, decoded })
        }

        if (pending.length) {
            const reverseKeys = [...new Set(pending.map((p) => `${p.decoded.user}_reverse`))]
            const stored = await this.keys.get('lid-mapping', reverseKeys)
            for (const { lid, decoded } of pending) {
                const pnUser = stored?.[`${decoded.user}_reverse`]
                if (pnUser && typeof pnUser === 'string') {
                    this.cache.set(`lid:${decoded.user}`, pnUser)
                    this.cache.set(`pn:${pnUser}`, decoded.user)
                    resolve(lid, decoded, pnUser)
                }
            }
        }

        const values = Object.values(out)
        return values.length ? values : null
    }

    close() {
        this.cache.clear()
    }
}
exports.LIDMappingStore = LIDMappingStore