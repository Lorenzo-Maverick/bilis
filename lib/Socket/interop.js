"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
exports.makeInteropSocket = void 0

const { getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } = require("../WABinary")
const { executeWMexQuery } = require("./mex")

const INTEROP_MEX_QUERY_IDS = {
    CREATE_GROUP: '25726817620301611', LEAVE_GROUP: '25346167795013271',
    ADD_PARTICIPANTS: '25732168276369451', QUERY_GROUP_INFO: '32734144032867938',
    PRIVACY_SETTINGS_QUERY: '24849123668112654', PRIVACY_SETTINGS_UPDATE: '25421856497452763',
    PRIVACY_SETTINGS_WITH_CONTACT_LIST: '24913399124998598'
}

const INTEGRATOR_BIRDYCHAT = 12
const INTEGRATOR_HAIKET = 13

const makeInteropSocket = (sock) => {
    const { query, generateMessageTag, logger, signalRepository } = sock
    const mexQuery = (variables, queryId, dataPath) =>
        executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

    const fetchIntegrators = async () => {
        const result = await query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:interop', to: S_WHATSAPP_NET }, content: [{ tag: 'integrator', attrs: { fetch: 'all' } }] })
        const listNode = getBinaryNodeChild(result, 'integrator_list')
        if (!listNode) return []
        const globalOptedIn = listNode.attrs?.opted_in === 'true'
        return getBinaryNodeChildren(listNode, 'integrator').map(node => {
            const featuresNode = getBinaryNodeChild(node, 'features')
            return { id: parseInt(node.attrs.id, 10), name: node.attrs.name, status: node.attrs.status, icon: node.attrs.icon, identifierType: node.attrs.identifier_type, optedIn: node.attrs.opted_in === 'true' || globalOptedIn, features: { groupMessaging: featuresNode?.attrs?.group_messaging === 'true' } }
        })
    }

    const acceptInteropTOS = async () => {
        const sendTOS = async (id, result) => await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'tos' }, content: [{ tag: 'trackable', attrs: { id, result } }] })
        await sendTOS('20240306', '105')
        await sendTOS('20240306', '160')
    }

    const optInIntegrators = async (integratorIds = [INTEGRATOR_BIRDYCHAT, INTEGRATOR_HAIKET]) => {
        await query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET }, content: [{ tag: 'opt_integrators', attrs: {}, content: [{ tag: 'integrator_list', attrs: {}, content: integratorIds.map(id => ({ tag: 'integrator', attrs: { id: id.toString() } })) }] }] })
    }

    const optOutIntegrators = async (integratorIds = [INTEGRATOR_BIRDYCHAT, INTEGRATOR_HAIKET]) => {
        await query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET }, content: [{ tag: 'opt_out_integrators', attrs: {}, content: [{ tag: 'integrator_list', attrs: {}, content: integratorIds.map(id => ({ tag: 'integrator', attrs: { id: id.toString() } })) }] }] })
    }

    const resolveInteropUsers = async users => {
        if (!users || users.length === 0) return []
        const result = await query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:interop', to: S_WHATSAPP_NET }, content: [{ tag: 'users', attrs: {}, content: users.map(({ externalId, integratorId }) => ({ tag: 'user', attrs: { external_id: externalId, integrator_id: integratorId.toString() } })) }] })
        const usersNode = getBinaryNodeChild(result, 'users')
        if (!usersNode) return []
        return getBinaryNodeChildren(usersNode, 'user').map(userNode => {
            const errorNode = getBinaryNodeChild(userNode, 'error')
            if (errorNode) return { externalId: userNode.attrs.external_id, integratorId: parseInt(userNode.attrs.integrator_id, 10), error: { code: parseInt(errorNode.attrs.code, 10), text: errorNode.attrs.text } }
            return { jid: userNode.attrs.jid, externalId: userNode.attrs.external_id, normalizedExternalId: userNode.attrs.normalized_external_id, integratorId: parseInt(userNode.attrs.integrator_id, 10) }
        })
    }

    const resolveInteropUser = async (externalId, integratorId) => {
        const results = await resolveInteropUsers([{ externalId, integratorId }])
        return results[0] ?? null
    }

    const blockInteropUser = async jid => await query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET }, content: [{ tag: 'blocklist', attrs: {}, content: [{ tag: 'item', attrs: { action: 'block', jid } }] }] })
    const unblockInteropUser = async jid => await query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET }, content: [{ tag: 'blocklist', attrs: {}, content: [{ tag: 'item', attrs: { action: 'unblock', jid } }] }] })

    const initInterop = async () => {
        let integrators
        try { integrators = await fetchIntegrators() } catch (err) { logger.warn({ err }, 'interop: failed to fetch integrators'); return [] }
        const toOptIn = integrators.filter(i => i.status === 'active' || i.status === 'onboarding')
        if (toOptIn.length === 0) return integrators
        try { await acceptInteropTOS() } catch (err) { logger.warn({ err }, 'interop: failed to accept TOS') }
        try { await optInIntegrators(toOptIn.map(i => i.id)) } catch (err) { logger.warn({ err }, 'interop: failed to opt-in integrators') }
        return integrators
    }

    const createInteropGroup = async participants =>
        mexQuery({ input: { participants: participants.map(jid => ({ jid })) } }, INTEROP_MEX_QUERY_IDS.CREATE_GROUP, 'xwa2_interop_group_create')

    const leaveInteropGroup = async jids => {
        const ids = Array.isArray(jids) ? jids : [jids]
        return mexQuery({ input: { groups_to_leave: ids.map(jid => ({ gid: jid.split('@')[0] })) } }, INTEROP_MEX_QUERY_IDS.LEAVE_GROUP, 'xwa2_interop_group_leave')
    }

    const addParticipantsToInteropGroup = async (groupJid, participants) =>
        mexQuery({ input: { gid: groupJid.split('@')[0], participants: participants.map(jid => ({ jid })) } }, INTEROP_MEX_QUERY_IDS.ADD_PARTICIPANTS, 'xwa2_interop_add_participants_to_group')

    const queryInteropGroupInfo = async groupJid =>
        mexQuery({ group_input: { gid: groupJid.split('@')[0] } }, INTEROP_MEX_QUERY_IDS.QUERY_GROUP_INFO, 'xwa2_interop_group_query_by_id')

    const updateInteropPrivacySetting = async (feature, setting) =>
        mexQuery({ feature, setting }, INTEROP_MEX_QUERY_IDS.PRIVACY_SETTINGS_UPDATE, 'xwa2_interop_privacy_setting_update')

    return {
        ...sock,
        fetchIntegrators, acceptInteropTOS, optInIntegrators, optOutIntegrators,
        resolveInteropUser, resolveInteropUsers, blockInteropUser, unblockInteropUser,
        initInterop, createInteropGroup, leaveInteropGroup, addParticipantsToInteropGroup,
        queryInteropGroupInfo, updateInteropPrivacySetting,
        INTEGRATOR_BIRDYCHAT, INTEGRATOR_HAIKET, INTEROP_MEX_QUERY_IDS
    }
}

module.exports = { makeInteropSocket, INTEGRATOR_BIRDYCHAT, INTEGRATOR_HAIKET, INTEROP_MEX_QUERY_IDS }