"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
exports.pre_key_manager = void 0

/**
 * @file pre-key-manager.js
 * @description Serializes prekey/session-key mutations per key type so
 *   concurrent transactions don't race on the same keyType bucket.
 *   Batches updates vs deletions, and validates deletions against what
 *   actually exists in the store before applying them.
 *   Uses a small built-in FIFO queue (concurrency 1 per keyType) instead
 *   of an external package, to keep bilis dependency-free/CJS-clean.
 * @author Denzy ZeroDay
 */

/** Minimal FIFO async queue running one task at a time. */
class _simple_queue {
    constructor() {
        this._tail = Promise.resolve()
    }
    add(task) {
        const run = this._tail.then(() => task())
        // swallow errors for chaining purposes, real error still propagates to caller via `run`
        this._tail = run.catch(() => {})
        return run
    }
}

class pre_key_manager {
    /**
     * @param {object} store - key store with async get(keyType, ids) => { [id]: value }
     * @param {object} logger - logger with .warn(msg)
     */
    constructor(store, logger) {
        this.store = store
        this.logger = logger
        this.queues = new Map()
    }

    /** Get (or create) the serial queue for a given key type */
    get_queue(key_type) {
        if (!this.queues.has(key_type)) {
            this.queues.set(key_type, new _simple_queue())
        }
        return this.queues.get(key_type)
    }

    /**
     * Process pending mutations (updates + deletions) for a key type,
     * serialized against any other in-flight operation on the same key type.
     */
    async process_operations(data, key_type, transaction_cache, mutations, is_in_transaction) {
        const key_data = data[key_type]
        if (!key_data) return

        return this.get_queue(key_type).add(async () => {
            transaction_cache[key_type] = transaction_cache[key_type] || {}
            mutations[key_type] = mutations[key_type] || {}

            const deletions = []
            const updates = {}
            for (const key_id in key_data) {
                if (key_data[key_id] === null) {
                    deletions.push(key_id)
                } else {
                    updates[key_id] = key_data[key_id]
                }
            }

            if (Object.keys(updates).length > 0) {
                Object.assign(transaction_cache[key_type], updates)
                Object.assign(mutations[key_type], updates)
            }
            if (deletions.length > 0) {
                await this.process_deletions(key_type, deletions, transaction_cache, mutations, is_in_transaction)
            }
        })
    }

    /**
     * Apply deletions, skipping any id that doesn't actually exist
     * (in the transaction cache if in-transaction, else in the real store).
     */
    async process_deletions(key_type, ids, transaction_cache, mutations, is_in_transaction) {
        if (is_in_transaction) {
            for (const key_id of ids) {
                if (transaction_cache[key_type]?.[key_id]) {
                    transaction_cache[key_type][key_id] = null
                    mutations[key_type][key_id] = null
                } else {
                    this.logger.warn(`Skipping deletion of non-existent ${key_type} in transaction: ${key_id}`)
                }
            }
        } else {
            const existing_keys = await this.store.get(key_type, ids)
            for (const key_id of ids) {
                if (existing_keys[key_id]) {
                    transaction_cache[key_type][key_id] = null
                    mutations[key_type][key_id] = null
                } else {
                    this.logger.warn(`Skipping deletion of non-existent ${key_type}: ${key_id}`)
                }
            }
        }
    }

    /**
     * Pre-validate a batch of pending deletions against the store,
     * dropping any that reference a non-existent key (mutates `data` in place).
     */
    async validate_deletions(data, key_type) {
        const key_data = data[key_type]
        if (!key_data) return

        return this.get_queue(key_type).add(async () => {
            const deletion_ids = Object.keys(key_data).filter(id => key_data[id] === null)
            if (deletion_ids.length === 0) return

            const existing_keys = await this.store.get(key_type, deletion_ids)
            for (const key_id of deletion_ids) {
                if (!existing_keys[key_id]) {
                    this.logger.warn(`Skipping deletion of non-existent ${key_type}: ${key_id}`)
                    delete data[key_type][key_id]
                }
            }
        })
    }
}

exports.pre_key_manager = pre_key_manager
module.exports = { pre_key_manager }