'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.attachLidMapping = void 0

const lid_mapping_1 = require('../Signal/lid-mapping')
const WAUSync_1 = require('../WAUSync')
const WABinary_1 = require('../WABinary')

const isPnJid = (jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')
const isLidJid = (jid) => typeof jid === 'string' && jid.endsWith('@lid')

/**
 * LID <-> PN helpers, on demand.
 *
 * - Always available, but lazy: nothing is created, listened to or written until
 *   one of the helpers is called. A bot that never calls them (JID only) behaves
 *   exactly like before.
 * - config.enableLidMapping = true additionally learns mappings passively from
 *   events that already exist (never touches decode / send / session code).
 *
 * API: sock.getLIDForPN / getPNForLID / getLIDsForPNs / getPNsForLIDs /
 *      storeLIDPNMappings / normalizeJid(jid, 'pn' | 'lid') / sock.lidMapping
 *      (also exposed as sock.signalRepository.lidMapping, same shape as baileys master)
 */
const attachLidMapping = (sock, config) => {
    const logger = config.logger
    let store = null

    const pnToLIDFunc = async (jids) => {
        const query = new WAUSync_1.USyncQuery().withLIDProtocol().withContext('background')
        for (const jid of jids) {
            if (isLidJid(jid)) continue
            query.withUser(new WAUSync_1.USyncUser().withId(jid))
        }
        if (query.users.length === 0) return []
        const results = await sock.executeUSyncQuery(query)
        if (!results) return []
        return results.list.filter((a) => !!a.lid).map(({ lid, id }) => ({ pn: id, lid }))
    }

    const getStore = () => {
        if (store) return store
        store = new lid_mapping_1.LIDMappingStore(sock.authState.keys, logger, pnToLIDFunc)
        const end = sock.end
        sock.end = (error) => {
            try {
                store.close()
            } catch (_) {}
            return end(error)
        }
        return store
    }

    const safeStore = (pairs) =>
        getStore()
            .storeLIDPNMappings(pairs)
            .catch((err) => logger?.warn?.({ err }, 'failed to store LID mapping'))

    // lookups: lazy store, never throw into the caller's flow
    sock.getLIDForPN = (pn) => getStore().getLIDForPN(pn)
    sock.getPNForLID = (lid) => getStore().getPNForLID(lid)
    sock.getLIDsForPNs = (pns) => getStore().getLIDsForPNs(pns)
    sock.getPNsForLIDs = (lids) => getStore().getPNsForLIDs(lids)
    sock.storeLIDPNMappings = (pairs) => getStore().storeLIDPNMappings(pairs)

    /** Convert a jid to the wanted form. Unknown or already-correct jids are returned unchanged. */
    sock.normalizeJid = async (jid, to = 'pn') => {
        try {
            if (to === 'pn' && isLidJid(jid)) return (await getStore().getPNForLID(jid)) || jid
            if (to === 'lid' && isPnJid(jid)) return (await getStore().getLIDForPN(jid)) || jid
        } catch (err) {
            logger?.warn?.({ err }, 'normalizeJid failed')
        }
        return jid
    }

    Object.defineProperty(sock, 'lidMapping', { get: getStore, enumerable: false, configurable: true })
    try {
        if (sock.signalRepository && !('lidMapping' in sock.signalRepository)) {
            Object.defineProperty(sock.signalRepository, 'lidMapping', {
                get: getStore,
                enumerable: false,
                configurable: true
            })
        }
    } catch (_) {}

    // passive learning, opt-in only
    if (config.enableLidMapping) {
        sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
            if (lid && jid) safeStore([{ lid, pn: jid }])
        })
        sock.ev.on('lid-mapping.update', (pair) => {
            if (pair?.lid && pair?.pn) safeStore([{ lid: pair.lid, pn: pair.pn }])
        })
        sock.ev.on('connection.update', ({ connection }) => {
            if (connection !== 'open') return
            const me = sock.authState.creds.me
            if (me?.id && me?.lid) {
                safeStore([
                    {
                        pn: (0, WABinary_1.jidNormalizedUser)(me.id),
                        lid: (0, WABinary_1.jidNormalizedUser)(me.lid)
                    }
                ])
            }
        })
    }
    return sock
}
exports.attachLidMapping = attachLidMapping