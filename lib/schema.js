'use strict';

const { Validator } = require('express-json-validator-middleware');
const $RefParser = require('json-schema-ref-parser');
const path = require('path');
const Err = require('./error');
const SchemaRoute = require('../routes/schema');
const { ValidationError } = require('express-json-validator-middleware');

/**
 * @class
 */
class Param {
    static integer(req, name) {
        req.params[name] = parseInt(req.params[name]);
        if (isNaN(req.params[name])) {
            throw new Err(400, null, `${name} param must be an integer`);
        }
    }

    static number(req, name) {
        req.params[name] = Number(req.params[name]);
        if (isNaN(req.params[name])) {
            throw new Err(400, null, `${name} param must be numeric`);
        }
    }

    static boolean(req, name) {
        if (!['true', 'false'].includes(req.params[name])) throw new Error(`${name} param must be a boolean`);
        req.params[name] = req.params[name] === true ? true : false;
    }

    static string(req, name) {
        req.params[name] = String(req.params[name]);
    }
}

/**
 * @class
 */
class Schemas {
    /**
     * @constructor
     *
     * @param {Object} router Express Router Object
     * @param {Object} opts Options Object
     * @param {String} opts.schemas Schemas Path
     */
    constructor(router, opts = {}) {
        if (!router) throw new Error('Router Param Required');

        if (!opts.schemas) {
            this.schemas_path = path.resolve(__dirname, '../schema/');
        } else {
            this.schemas_path = opts.schemas;
        }

        this.validator = new Validator({
            removeAdditional: true,
            useDefaults: true,
            allErrors: true
        });

        this.router = router;
        this.schemas = new Map();
        this.validate = this.validator.validate;
    }

    async api() {
        await SchemaRoute(this);
    }

    check(url, schemas, fns) {
        if (typeof url !== 'string') throw new Error('URL should be string');

        if (schemas === null) schemas = {};
        if (typeof schemas !== 'object') throw new Error('Schemas should be object');

        // Make sure express params are validated/coerced into proper type
        const matches = url.match(/(:.+?)(?=\/|\.|$)/g);
        if (matches) for (const match of matches) {
            if (!schemas[match]) throw new Error(`${match} type is not defined in schema`);
            if (!Param[schemas[match]]) throw new Error(`${schemas[match]} is not a supported type for ${match}`);
        }

        if (!fns.length) throw new Error('At least 1 route function should be defined');
    }

    async get(url, schemas, ...fns) {
        this.check(url, schemas, fns);
        this.router.get(...await this.generic(`GET ${url}`, schemas), ...fns);
    }

    async delete(url, schemas, ...fns) {
        this.check(url, schemas, fns);
        this.router.delete(...await this.generic(`DELETE ${url}`, schemas), ...fns);
    }

    async post(url, schemas, ...fns) {
        this.check(url, schemas, fns);
        this.router.post(...await this.generic(`POST ${url}`, schemas), ...fns);
    }

    async patch(url, schemas, ...fns) {
        this.check(url, schemas, fns);
        this.router.patch(...await this.generic(`PATCH ${url}`, schemas), ...fns);
    }

    async put(url, schemas, ...fns) {
        this.check(url, schemas, fns);
        this.router.put(...await this.generic(`PUT ${url}`, schemas), ...fns);
    }

    async generic(url, schemas = {}) {
        if (!schemas) schemas = {};

        const parsed = url.split(' ');
        if (parsed.length !== 2) throw new Error('schema.generic() must be of format "<VERB> <URL>"');

        for (const type of ['body', 'query', 'res']) {
            if (!schemas[type]) continue;

            try {
                schemas[type] = await $RefParser.dereference(path.resolve(path.resolve(__dirname, '../schema/'), schemas[type]));
            } catch (err) {
                schemas[type] = await $RefParser.dereference(path.resolve(this.schemas_path, schemas[type]));
            }
        }

        this.schemas.set(parsed.join(' '), schemas);

        const opts = {};
        if (schemas.query) opts.query = schemas.query;
        if (schemas.body) opts.body = schemas.body;

        const flow = [parsed[1], []];

        if (schemas.query) flow[1].push(Schemas.query(schemas.query));

        // Make sure express params are validated/coerced into proper type
        const matches = url.match(/(:.+?)(?=\/|\.|$)/g);
        if (matches) for (const match of matches) {
            if (!schemas[match]) throw new Error(`${match} type is not defined in schema`);

            flow[1].push(Schemas.param(match, schemas[match]));
        }

        flow[1].push(this.validate(opts));

        return flow;
    }

    /**
     * Express middleware to identify express params that should be integers/number/booleans
     * according to the schema and attempt to cast them as such to ensure they pass the schema
     *
     * @param {String} match Express Param
     * @param {String} type Type to coerce it to
     *
     * @returns {Function}
     */
    static param(match, type) {
        return function (req, res, next) {

            try {
                Param[type](req, match.replace(':', ''));
            } catch (err) {
                return Err.respond(err, res);
            }

            return next();
        };
    }

    /**
     * Express middleware to identify query params that should be integers/booleans according to the schema
     * and attempt to cast them as such to ensure they pass the schema
     *
     * @param {Object} schema JSON Schema
     *
     * @returns {Function}
     */
    static query(schema) {
        return function (req, res, next) {
            for (const key of Object.keys(req.query)) {
                if (!schema.properties[key] || !schema.properties[key].type) continue;

                // For easier processing use consistent array format IE: `type: ["integer", "boolean"]` vs type: "integer"
                if (!Array.isArray(schema.properties[key].type)) schema.properties[key].type = [schema.properties[key].type];

                for (const type of schema.properties[key].type) {
                    if (type === 'integer' && !isNaN(parseInt(req.query[key]))) {
                        req.query[key] = parseInt(req.query[key]);
                    } else if (type === 'number' && !isNaN(Number(req.query[key]))) {
                        req.query[key] = Number(req.query[key]);
                    } else if (type === 'array') {
                        req.query[key] = req.query[key].split(',');
                    } else if (type === 'boolean') {
                        if (req.query[key] === 'true') {
                            req.query[key] = true;
                        } else if (req.query[key] === 'false') {
                            req.query[key] = false;
                        }
                    }
                }
            }

            for (const key of Object.keys(schema.properties)) {
                if (req.query[key] === undefined && schema.properties[key].default) {
                    req.query[key] = schema.properties[key].default;
                }
            }

            return next();
        };
    }

    /**
     * Return all schemas (body, query, etc) for a given method + url
     *
     * @param {String} method HTTP Method
     * @param {String} url URL
     *
     * @returns {Object}
     */
    query(method, url) {
        if (!this.schemas.has(`${method} ${url}`)) {
            return { body: null, schema: null };
        }

        const schema = JSON.parse(JSON.stringify(this.schemas.get(`${method} ${url}`)));
        if (!schema.query) schema.query = null;
        if (!schema.body) schema.body = null;
        if (!schema.res) schema.res = null;

        return schema;
    }

    /**
     * Convert validation errors into standardized JSON Error Messages
     */
    error() {
        this.router.use((err, req, res, next) => {
            if (err instanceof ValidationError) {
                let errs = [];
                if (err.validationErrors.body) {
                    errs = errs.concat(err.validationErrors.body);
                }

                if (err.validationErrors.query) {
                    errs = errs.concat(err.validationErrors.query);
                }

                return Err.respond(
                    new Err(400, null, 'validation error'),
                    res,
                    errs
                );
            } else {
                next(err);
            }
        });
    }

    /**
     * Return a list of endpoints with schemas
     *
     * @returns {Object}
     */
    list() {
        const lite = {};

        for (const key of this.schemas.keys()) {
            lite[key] = {
                body: !!this.schemas.get(key).body,
                query: !!this.schemas.get(key).query,
                res: !!this.schemas.get(key).res
            };
        }

        return lite;
    }
}

module.exports = Schemas;
