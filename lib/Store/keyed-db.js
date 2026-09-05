"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
exports.keyed_db = void 0

/**
 * @file keyed-db.js
 * @description In-memory sorted store with O(1) id lookup — keeps an
 *   array sorted by a compare function (for ordered iteration/pagination)
 *   plus a dict keyed by id (for instant get/update/delete). Used as a
 *   fast alternative index for chats/contacts/messages stores.
 * @author Denzy ZeroDay
 */

class keyed_db {
    /**
     * @param {(a, b) => number} compare_fn - sort comparator for the ordered array
     * @param {(entry) => string} id_getter - extracts the unique id from an entry
     */
    constructor(compare_fn, id_getter) {
        if (typeof compare_fn !== 'function' || typeof id_getter !== 'function') {
            throw new Error('keyed_db requires compare and id_getter functions')
        }
        this._compare = compare_fn
        this._id_getter = id_getter
        this._array = []
        this._dict = {}
    }

    get length() {
        return this._array.length
    }

    /** Get an entry by its id — O(1) */
    get(id) {
        return this._dict[id]
    }

    /**
     * Insert an entry in sorted position.
     * mode: 'insert' (default, fails if id exists) or 'upsert'-like overwrite via other methods.
     */
    insert(entry, mode = 'insert') {
        const id = this._id_getter(entry)
        const existing = this._dict[id]
        if (existing && mode === 'insert') return false

        this._dict[id] = entry
        let inserted = false
        for (let i = 0; i < this._array.length; i++) {
            const cmp = this._compare(entry, this._array[i])
            if (cmp < 0) {
                this._array.splice(i, 0, entry)
                inserted = true
                break
            }
        }
        if (!inserted) this._array.push(entry)
        return true
    }

    /** Insert only entries whose id doesn't already exist. Returns the ones actually added. */
    insert_if_absent(...entries) {
        const added = []
        for (const entry of entries) {
            if (!this._dict[this._id_getter(entry)]) {
                this.insert(entry)
                added.push(entry)
            }
        }
        return added
    }

    /** Insert or replace entries by id. Returns the newly-added ones (not the replaced ones). */
    upsert(...entries) {
        const added = []
        for (const entry of entries) {
            const id = this._id_getter(entry)
            if (this._dict[id]) {
                const idx = this._array.findIndex(e => this._id_getter(e) === id)
                if (idx >= 0) this._array[idx] = entry
                this._dict[id] = entry
            } else {
                this.insert(entry)
                added.push(entry)
            }
        }
        return added
    }

    /** Mutate an existing entry in place via updater(item). Returns false if id not found. */
    update(id, updater) {
        const item = this._dict[id]
        if (!item) return false
        updater(item)
        const idx = this._array.findIndex(e => this._id_getter(e) === id)
        if (idx >= 0) this._array[idx] = item
        return true
    }

    /** Object.assign a partial update onto an existing entry. Returns false if id not found. */
    update_assign(id, update) {
        const item = this._dict[id]
        if (!item) return false
        Object.assign(item, update)
        const idx = this._array.findIndex(e => this._id_getter(e) === id)
        if (idx >= 0) this._array[idx] = item
        return true
    }

    /** Remove an entry by id. Returns false if id not found. */
    delete_by_id(id) {
        if (!this._dict[id]) return false
        delete this._dict[id]
        const idx = this._array.findIndex(e => this._id_getter(e) === id)
        if (idx >= 0) this._array.splice(idx, 1)
        return true
    }

    /** Remove all entries */
    clear() {
        this._array = []
        this._dict = {}
    }

    /** Get a snapshot copy of all entries in sorted order */
    all() {
        return [...this._array]
    }

    /** Filter entries in place, keeping only those matching predicate. Rebuilds the id dict. */
    filter(predicate) {
        this._array = this._array.filter(predicate)
        this._dict = {}
        for (const entry of this._array) {
            this._dict[this._id_getter(entry)] = entry
        }
    }

    /** Number of entries currently stored */
    count() {
        return this._array.length
    }

    /** Serialize to a plain array for persistence */
    to_json() {
        return this._array
    }

    /** Restore from a plain array (clears existing entries first) */
    from_json(array) {
        this.clear()
        for (const entry of array) this.insert(entry)
    }
}

exports.keyed_db = keyed_db
module.exports = keyed_db
module.exports.keyed_db = keyed_db
