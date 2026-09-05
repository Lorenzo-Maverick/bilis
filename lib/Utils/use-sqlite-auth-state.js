"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
exports.use_sqlite_auth_state = void 0

/**
 * @file use-sqlite-auth-state.js
 * @description Auth state persisted in a local SQLite database (using
 *   Node's built-in `node:sqlite` — no external DB driver needed).
 *   Much faster and more robust than one-file-per-key JSON storage for
 *   bots with heavy session key churn. Requires Node.js 22.5+.
 *   Can auto-migrate an existing folder-based (useMultiFileAuthState)
 *   session into the new SQLite db on first run.
 * @author Denzy ZeroDay
 */

const { mkdir, readdir, readFile } = require('fs/promises')
const { dirname, join } = require('path')
const { proto } = require('../../WAProto')
const { initAuthCreds } = require('./auth-utils')

/**
 * @param {string} path_or_folder - full .db/.sqlite path, or a folder (fileName is appended)
 * @param {object} options
 * @param {string} options.fileName - db file name when path_or_folder is a folder (default 'auth.db')
 * @param {string} options.migrateFromFolder - optional legacy useMultiFileAuthState folder to import from on first run
 * @param {object} options.logger - optional logger with .warn/.info
 * @returns {Promise<{ state, saveCreds, db, close }>}
 */
const use_sqlite_auth_state = async (path_or_folder, options = {}) => {
    const { fileName = 'auth.db', migrateFromFolder: migrate_from_folder, logger } = options
    const db_path = /\.(db|sqlite|sqlite3)$/i.test(path_or_folder) ? path_or_folder : join(path_or_folder, fileName)

    const buf_replacer = (_, value) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
            return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') }
        }
        return value
    }

    const buf_reviver = (_, value) => {
        if (value && typeof value === 'object' && value.type === 'Buffer' && typeof value.data === 'string') {
            return Buffer.from(value.data, 'base64')
        }
        return value
    }

    const encode = (value) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
            return Buffer.concat([Buffer.from([1]), Buffer.from(value)])
        }
        return Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value, buf_replacer), 'utf8')])
    }

    const decode = (blob) => {
        if (!blob || blob.length === 0) return null
        if (blob[0] === 1) return Buffer.from(blob.subarray(1))
        return JSON.parse(Buffer.from(blob.subarray(1)).toString('utf8'), buf_reviver)
    }

    const fix_name = (s) => s?.replace(/\//g, '__')?.replace(/:/g, '-')
    const key_of = (category, id) => fix_name(`${category}-${id}`)

    let DatabaseSync
    try {
        ;({ DatabaseSync } = await import('node:sqlite'))
    } catch (err) {
        throw new Error("use_sqlite_auth_state needs the built-in 'node:sqlite' module (Node 22.5+). Upgrade Node, or use useMultiFileAuthState instead.")
    }

    await mkdir(dirname(db_path), { recursive: true }).catch(() => {})

    const db = new DatabaseSync(db_path)
    db.exec('PRAGMA journal_mode = TRUNCATE')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('CREATE TABLE IF NOT EXISTS auth_state (k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID')

    const q_get = db.prepare('SELECT v FROM auth_state WHERE k = ?')
    const q_upsert = db.prepare('INSERT INTO auth_state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    const q_delete = db.prepare('DELETE FROM auth_state WHERE k = ?')

    const run_tx = (fn) => {
        db.exec('BEGIN')
        try {
            const r = fn()
            db.exec('COMMIT')
            return r
        } catch (err) {
            db.exec('ROLLBACK')
            throw err
        }
    }

    const read_raw = (k) => {
        const row = q_get.get(k)
        if (!row) return null
        try {
            return decode(row.v)
        } catch (err) {
            logger?.warn?.({ k, err: err?.message }, 'sqlite-auth: failed to decode row, treating as missing')
            return null
        }
    }

    const run_migration = async (folder) => {
        let files
        try {
            files = await readdir(folder)
        } catch {
            return 0
        }
        const rows = []
        for (const file of files) {
            if (!file.endsWith('.json')) continue
            let value
            try {
                value = JSON.parse(await readFile(join(folder, file), 'utf8'), buf_reviver)
            } catch {
                continue
            }
            if (value === null || value === undefined) continue
            rows.push([file.slice(0, -'.json'.length), encode(value)])
        }
        run_tx(() => {
            for (const [k, v] of rows) q_upsert.run(k, v)
        })
        return rows.length
    }

    const has_creds = () => !!q_get.get('creds')

    if (migrate_from_folder && !has_creds()) {
        const n = await run_migration(migrate_from_folder)
        if (n > 0) logger?.info?.({ count: n, from: migrate_from_folder }, 'sqlite-auth: migrated legacy auth state')
    }

    let creds = read_raw('creds')
    if (!creds) {
        creds = initAuthCreds()
        q_upsert.run('creds', encode(creds))
    }

    const keys = {
        get: async (type, ids) => {
            const data = {}
            for (const id of ids) {
                let value = read_raw(key_of(type, id))
                if (type === 'app-state-sync-key' && value) {
                    value = proto.Message.AppStateSyncKeyData.fromObject(value)
                }
                if (value !== null && value !== undefined) {
                    data[id] = value
                }
            }
            return data
        },
        set: async (data) => {
            const ops = []
            for (const category in data) {
                for (const id in data[category]) {
                    ops.push([key_of(category, id), data[category][id]])
                }
            }
            run_tx(() => {
                for (const [k, value] of ops) {
                    if (value === null || value === undefined) q_delete.run(k)
                    else q_upsert.run(k, encode(value))
                }
            })
        },
        clear: async () => {
            db.prepare("DELETE FROM auth_state WHERE k <> 'creds'").run()
        }
    }

    return {
        state: { creds, keys },
        saveCreds: async () => {
            q_upsert.run('creds', encode(creds))
        },
        db,
        close: () => db.close()
    }
}

exports.use_sqlite_auth_state = use_sqlite_auth_state
module.exports = { use_sqlite_auth_state }