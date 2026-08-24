// Doble mínimo del driver de MongoDB: suficiente para ejercitar server-saas.js
// en el arranque real sin necesitar un mongod. Sólo implementa lo que usa el
// servidor: createIndex, findOne, insertOne, updateOne y find().sort().limit().
const { ObjectId } = require('mongodb/lib/bson');

function igual(v, q) {
    // Mongo de verdad: consultar por null trae tanto los documentos con el
    // campo en null como los que ni siquiera tienen ese campo. Sin este caso
    // especial, JSON.stringify(undefined) da "undefined" (el valor, no un
    // string) y nunca es igual a JSON.stringify(null) === "null".
    if (q === null) return v === null || v === undefined;
    if (q instanceof ObjectId) return v && v.toString() === q.toString();
    if (v instanceof ObjectId) return q && v.toString() === q.toString();
    return JSON.stringify(v) === JSON.stringify(q);
}

function matches(doc, query) {
    return Object.keys(query).every((k) => {
        const q = query[k];
        const v = doc[k];
        // Operadores de consulta que usa el servidor
        if (q && typeof q === 'object' && !Array.isArray(q) && !(q instanceof ObjectId)) {
            const ops = Object.keys(q);
            if (ops.length && ops.every((o) => o.startsWith('$'))) {
                return ops.every((o) => {
                    switch (o) {
                        case '$ne':  return !igual(v, q[o]);
                        case '$eq':  return igual(v, q[o]);
                        case '$gt':  return v > q[o];
                        case '$gte': return v >= q[o];
                        case '$lt':  return v < q[o];
                        case '$lte': return v <= q[o];
                        case '$in':  return Array.isArray(q[o]) && q[o].some((x) => igual(v, x));
                        case '$exists': return (v !== undefined) === Boolean(q[o]);
                        default: throw new Error('fake-mongo: operador no soportado ' + o);
                    }
                });
            }
        }
        return igual(v, q);
    });
}

class FakeCollection {
    constructor(name) {
        this.name = name;
        this.docs = [];
        this.uniqueKeys = [];
    }

    async createIndex(spec, opts) {
        if (opts && opts.unique) this.uniqueKeys.push(Object.keys(spec)[0]);
        return 'idx';
    }

    async findOne(query) {
        const d = this.docs.find((doc) => matches(doc, query));
        return d ? Object.assign({}, d) : null;
    }

    async insertOne(doc) {
        for (const k of this.uniqueKeys) {
            if (this.docs.some((d) => d[k] === doc[k])) {
                const err = new Error('E11000 duplicate key error');
                err.code = 11000;
                throw err;
            }
        }
        const _id = doc._id || new ObjectId();
        const stored = Object.assign({}, doc, { _id });
        this.docs.push(stored);
        return { insertedId: _id, acknowledged: true };
    }

    async updateOne(filter, update) {
        const d = this.docs.find((doc) => matches(doc, filter));
        if (!d) return { matchedCount: 0, modifiedCount: 0 };
        for (const op of Object.keys(update)) {
            if (!['$set', '$inc', '$unset'].includes(op)) {
                throw new Error('fake-mongo: operador de update no soportado ' + op);
            }
        }
        if (update.$set) Object.assign(d, update.$set);
        if (update.$inc) {
            for (const k of Object.keys(update.$inc)) {
                d[k] = (d[k] || 0) + update.$inc[k];
            }
        }
        if (update.$unset) {
            for (const k of Object.keys(update.$unset)) delete d[k];
        }
        return { matchedCount: 1, modifiedCount: 1 };
    }

    async deleteOne(filter) {
        const i = this.docs.findIndex((doc) => matches(doc, filter));
        if (i === -1) return { deletedCount: 0 };
        this.docs.splice(i, 1);
        return { deletedCount: 1 };
    }

    find(query) {
        let rows = this.docs.filter((d) => matches(d, query)).map((d) => Object.assign({}, d));
        const api = {
            sort(spec) {
                const keys = Object.keys(spec);
                rows.sort((a, b) => {
                    for (const k of keys) {
                        const dir = spec[k];
                        const av = a[k], bv = b[k];
                        if (av < bv) return -1 * dir;
                        if (av > bv) return 1 * dir;
                    }
                    return 0;
                });
                return api;
            },
            limit(n) { rows = rows.slice(0, n); return api; },
            async toArray() { return rows; }
        };
        return api;
    }
}

class FakeDb {
    constructor() { this.cols = new Map(); }
    collection(name) {
        if (!this.cols.has(name)) this.cols.set(name, new FakeCollection(name));
        return this.cols.get(name);
    }
}

let lastDb = null;

class FakeMongoClient {
    constructor(uri) { this.uri = uri; this._db = new FakeDb(); lastDb = this._db; }
    async connect() { return this; }
    db() { return this._db; }
    async close() { return; }
}

module.exports = {
    MongoClient: FakeMongoClient,
    ObjectId,
    FakeDb,
    getDb: () => lastDb
};
