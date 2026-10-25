import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { ZodError } from 'zod';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { sessionHook, authRoutes } from './auth.js';
import { adminRoutes } from './admin.js';
import { leaseRoutes } from './leases.js';
import { platformSessionHook, platformRoutes } from './platform.js';
import { roleRoutes } from './roles.js';
import { companySettingsRoutes } from './companySettings.js';
import { bankingRoutes } from './banking.js';
import { recordRoutes } from './records.js';
import { aiRoutes } from './ai.js';
import { HttpError } from './rbac.js';
import VALIDATION from './engine/validation.js';

export async function buildApp(cfg, { logger = true } = {}) {
    const app = Fastify({ logger: logger ? { level: cfg.logLevel, redact: ['req.headers.cookie', 'req.body.password', 'req.body.current', 'req.body.next'] } : false, trustProxy: cfg.trustProxy, bodyLimit: 2 * 1024 * 1024 });
    const pool = createPool(cfg.databaseUrl);
    app.decorate('pg', pool);
    app.addHook('onClose', async () => pool.end());
    await migrate(pool, app.log);

    // Refuse to start if the calculation engine no longer reproduces the reference examples
    const v = VALIDATION.run();
    if (!v.every(x => x.pass)) throw new Error('Calculation engine failed validation: ' + v.filter(x => !x.pass).map(x => x.id).join(', '));

    await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"] } }, hsts: cfg.cookieSecure ? { maxAge: 31536000 } : false });
    await app.register(cookie);
    sessionHook(app, cfg);
    platformSessionHook(app, cfg);

    app.setErrorHandler((err, req, reply) => {
        if (err instanceof ZodError) return reply.status(400).send({ error: 'validation', message: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
        if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
        if (err.code === '23505') return reply.status(409).send({ error: 'duplicate', message: 'That record already exists.' });
        if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
        if (/engine|terms|Cannot/i.test(err.message) && req.url.startsWith('/api/leases')) return reply.status(400).send({ error: 'unmeasurable', message: 'The lease terms cannot be measured: ' + err.message });
        req.log.error(err);
        return reply.status(500).send({ error: 'internal', message: 'Something went wrong. The error has been logged.' }); // no internals leaked
    });

    app.get('/api/health', async () => {
        await pool.query('SELECT 1');
        return { status: 'ok', engineValidation: `${v.length}/${v.length}`, time: new Date().toISOString() };
    });
    authRoutes(app, cfg);
    adminRoutes(app, cfg);
    leaseRoutes(app, cfg);
    roleRoutes(app, cfg);
    companySettingsRoutes(app, cfg);
    bankingRoutes(app, cfg);
    recordRoutes(app, cfg);
    aiRoutes(app, cfg);
    platformRoutes(app, cfg);

    // Expired sessions are swept every 15 minutes
    const sweep = setInterval(() => {
        for (const t of ['sessions', 'platform_sessions']) pool.query(`DELETE FROM ${t} WHERE expires_at < now() OR last_seen < now() - ($1 || ' minutes')::interval`, [String(cfg.idleMinutes)]).catch(() => {});
    }, 15 * 60000);
    app.addHook('onClose', async () => clearInterval(sweep));
    return app;
}
