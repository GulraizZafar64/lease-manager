// Platform console API: the SaaS operator (platform owner) signs in separately from every
// company's users and adds companies with their super administrators, or makes them
// active or inactive. Same security model as company sign-in: scrypt passwords, MFA,
// lockout, forced change of temporary passwords, HttpOnly session cookie.
import { z } from 'zod';
import { hashPassword, verifyPassword, dummyVerify, passwordProblems, encrypt, decrypt, randomToken, sha256 } from './security/crypto.js';
import { newSecret, verifyTotp, otpauthUrl } from './security/totp.js';
import { HttpError } from './rbac.js';
import { audit } from './audit.js';
import { tx } from './db.js';

export const PLATFORM_COOKIE = 'lm_platform';
const ccy = z.string().regex(/^[A-Z]{3}$/);
const tempPassword = () => randomToken(12).replace(/[-_]/g, 'x') + '!7a';
// The acting platform administrator, as recorded in the platform's audit chain.
const actor = a => ({ id: a.id, name: a.name, role: 'platform-' + a.role });
export const publicAdmin = a => a && ({ id: a.id, email: a.email, name: a.name, role: a.role, mfaEnabled: a.mfa_enabled, mustChangePassword: a.must_change_password });

export function platformSessionHook(app, cfg) {
    app.decorateRequest('platformAdmin', null);
    app.decorateRequest('platformSession', null);
    app.addHook('onRequest', async (req) => {
        if (!req.url.startsWith('/api/platform/')) return;
        const token = req.cookies[PLATFORM_COOKIE];
        if (!token) return;
        const h = sha256(token);
        const s = (await app.pg.query('SELECT * FROM platform_sessions WHERE token_hash=$1', [h])).rows[0];
        if (!s) return;
        const now = Date.now();
        if (new Date(s.expires_at) < now || now - new Date(s.last_seen) > cfg.idleMinutes * 60000) { await app.pg.query('DELETE FROM platform_sessions WHERE token_hash=$1', [h]); return; }
        const a = (await app.pg.query('SELECT * FROM platform_admins WHERE id=$1', [s.admin_id])).rows[0];
        if (!a || a.status !== 'active') return;
        if (now - new Date(s.last_seen) > 60000) await app.pg.query('UPDATE platform_sessions SET last_seen=now() WHERE token_hash=$1', [h]);
        req.platformSession = s; req.platformAdmin = a;
    });
}
function requirePlatform(cfg, { allowPasswordChange = false, allowNoMfa = false } = {}) {
    return async (req) => {
        if (!req.platformAdmin) throw new HttpError(401, 'Sign in required', 'unauthenticated');
        if (!allowNoMfa && !req.platformSession.mfa_passed) throw new HttpError(401, 'Multi-factor verification required', 'mfa_required');
        if (!allowPasswordChange && req.platformAdmin.must_change_password) throw new HttpError(403, 'Change your password to continue', 'password_change_required');
    };
}

// Company list with what the platform owner needs to see: status, people and size.
async function companyList(db, id = null) {
    const { rows } = await db.query(`
        SELECT c.id, c.code, c.name, c.base_currency AS currency, c.status, c.status_changed_at AS "statusChangedAt", c.created_at AS "createdAt",
            (SELECT count(*)::int FROM users u WHERE u.company_id = c.id AND u.deleted_at IS NULL) AS "usersTotal",
            (SELECT count(*)::int FROM users u WHERE u.company_id = c.id AND u.deleted_at IS NULL AND u.status = 'active') AS "usersActive",
            (SELECT count(*)::int FROM leases l WHERE l.company_id = c.id) AS leases,
            coalesce((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email) ORDER BY u.name)
                      FROM users u WHERE u.company_id = c.id AND u.role = 'superadmin' AND u.status = 'active' AND u.deleted_at IS NULL), '[]') AS "superAdmins"
        FROM companies c WHERE ($1::uuid IS NULL OR c.id = $1) ORDER BY c.created_at DESC`, [id]);
    return rows;
}

export function platformRoutes(app, cfg) {
    const setCookie = (reply, token) => reply.setCookie(PLATFORM_COOKIE, token, { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict', path: '/', maxAge: cfg.sessionHours * 3600 });
    const signedIn = (opts) => ({ preHandler: requirePlatform(cfg, opts) });

    /* ---- Sign-in ---- */
    app.post('/api/platform/auth/login', async (req, reply) => {
        const { email, password } = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).parse(req.body);
        const a = (await app.pg.query('SELECT * FROM platform_admins WHERE lower(email)=lower($1)', [email])).rows[0];
        const fail = async (why) => {
            if (a) await tx(app.pg, async c => {
                const n = a.failed_logins + 1, lock = n >= cfg.maxFailedLogins;
                await c.query('UPDATE platform_admins SET failed_logins=$2, locked_until=$3 WHERE id=$1', [a.id, lock ? 0 : n, lock ? new Date(Date.now() + cfg.lockMinutes * 60000) : a.locked_until]);
                await audit(c, { user: actor(a), companyId: null, action: lock ? 'platform.auth.locked' : 'platform.auth.failed', objectType: 'platform_admin', objectId: a.id, detail: { why }, ip: req.ip });
            });
            throw new HttpError(401, 'Email or password is incorrect, or the account is locked.', 'bad_credentials');
        };
        if (!a) { await dummyVerify(password); return fail('unknown'); }
        if (a.locked_until && new Date(a.locked_until) > new Date()) { await dummyVerify(password); return fail('locked'); }
        if (a.status !== 'active') { await dummyVerify(password); return fail('disabled'); }
        if (!(await verifyPassword(password, a.password_hash))) return fail('password');
        const token = randomToken();
        // REQUIRE_MFA=false: no code is asked (see auth.js)
        const mfaPassed = !cfg.requireMfa;
        await tx(app.pg, async c => {
            await c.query('UPDATE platform_admins SET failed_logins=0, locked_until=NULL WHERE id=$1', [a.id]);
            await c.query('INSERT INTO platform_sessions(token_hash,admin_id,mfa_passed,expires_at,ip,user_agent) VALUES ($1,$2,$3,$4,$5,$6)', [sha256(token), a.id, mfaPassed, new Date(Date.now() + cfg.sessionHours * 3600000), req.ip, String(req.headers['user-agent'] || '').slice(0, 300)]);
            await audit(c, { user: actor(a), companyId: null, action: 'platform.auth.password_ok', objectType: 'platform_admin', objectId: a.id, ip: req.ip });
        });
        setCookie(reply, token);
        return { next: mfaPassed ? (a.must_change_password ? 'change_password' : 'done') : a.mfa_enabled ? 'mfa_verify' : 'mfa_enrol', mustChangePassword: a.must_change_password };
    });
    app.post('/api/platform/auth/mfa/setup', signedIn({ allowNoMfa: true, allowPasswordChange: true }), async (req) => {
        const a = req.platformAdmin;
        if (a.mfa_enabled) throw new HttpError(409, 'MFA is already set up.', 'mfa_exists');
        const secret = newSecret();
        await app.pg.query('UPDATE platform_admins SET mfa_secret_enc=$2 WHERE id=$1', [a.id, encrypt(secret, cfg.masterKey)]);
        return { secret, otpauthUrl: otpauthUrl(secret, `${a.email} (platform)`, cfg.orgName) };
    });
    app.post('/api/platform/auth/mfa/verify', signedIn({ allowNoMfa: true, allowPasswordChange: true }), async (req) => {
        const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
        const a = req.platformAdmin;
        if (!a.mfa_secret_enc) throw new HttpError(409, 'Set up MFA first', 'mfa_not_setup');
        const step = verifyTotp(decrypt(a.mfa_secret_enc, cfg.masterKey), code, { lastStep: a.mfa_last_step === null ? null : Number(a.mfa_last_step) });
        if (step === null) {
            await tx(app.pg, async c => {
                const n = a.failed_logins + 1, lock = n >= cfg.maxFailedLogins;
                await c.query('UPDATE platform_admins SET failed_logins=$2, locked_until=$3 WHERE id=$1', [a.id, lock ? 0 : n, lock ? new Date(Date.now() + cfg.lockMinutes * 60000) : null]);
                if (lock) await c.query('DELETE FROM platform_sessions WHERE admin_id=$1', [a.id]);
                await audit(c, { user: actor(a), companyId: null, action: lock ? 'platform.auth.locked' : 'platform.auth.mfa_failed', objectType: 'platform_admin', objectId: a.id, ip: req.ip });
            });
            throw new HttpError(401, 'That code is not valid.', 'bad_code');
        }
        await tx(app.pg, async c => {
            await c.query('UPDATE platform_admins SET mfa_enabled=true, mfa_last_step=$2, failed_logins=0 WHERE id=$1', [a.id, step]);
            await c.query('UPDATE platform_sessions SET mfa_passed=true WHERE token_hash=$1', [req.platformSession.token_hash]);
            await audit(c, { user: actor(a), companyId: null, action: a.mfa_enabled ? 'platform.auth.mfa_ok' : 'platform.auth.mfa_enrolled', objectType: 'platform_admin', objectId: a.id, ip: req.ip });
        });
        return { next: a.must_change_password ? 'change_password' : 'done' };
    });
    app.post('/api/platform/auth/password', signedIn({ allowPasswordChange: true }), async (req) => {
        const { current, next } = z.object({ current: z.string().max(200), next: z.string().max(200) }).parse(req.body);
        const a = req.platformAdmin;
        if (!(await verifyPassword(current, a.password_hash))) throw new HttpError(400, 'Current password is incorrect.', 'bad_password');
        const probs = passwordProblems(next, cfg.passwordMinLength, [a.name, a.email.split('@')[0]]);
        if (probs.length) throw new HttpError(400, 'Choose a password with ' + probs.join(', ') + '.', 'weak_password');
        if (await verifyPassword(next, a.password_hash)) throw new HttpError(400, 'Choose a password different from the current one.', 'same_password');
        await tx(app.pg, async c => {
            await c.query('UPDATE platform_admins SET password_hash=$2, must_change_password=false, password_changed_at=now() WHERE id=$1', [a.id, await hashPassword(next)]);
            await c.query('DELETE FROM platform_sessions WHERE admin_id=$1 AND token_hash<>$2', [a.id, req.platformSession.token_hash]);
            await audit(c, { user: actor(a), companyId: null, action: 'platform.auth.password_changed', objectType: 'platform_admin', objectId: a.id, ip: req.ip });
        });
        return { ok: true };
    });
    app.post('/api/platform/auth/logout', async (req, reply) => {
        if (req.platformSession) {
            await app.pg.query('DELETE FROM platform_sessions WHERE token_hash=$1', [req.platformSession.token_hash]);
            await tx(app.pg, c => audit(c, { user: actor(req.platformAdmin), companyId: null, action: 'platform.auth.logout', objectType: 'platform_admin', objectId: req.platformAdmin.id, ip: req.ip }));
        }
        reply.clearCookie(PLATFORM_COOKIE, { path: '/' });
        return { ok: true };
    });
    app.get('/api/platform/auth/me', async (req) => {
        if (!req.platformAdmin) throw new HttpError(401, 'Sign in required', 'unauthenticated');
        return { admin: publicAdmin(req.platformAdmin), mfaPassed: req.platformSession.mfa_passed };
    });

    /* ---- Companies ---- */
    app.get('/api/platform/companies', signedIn(), async () => companyList(app.pg));

    const newCompany = z.object({
        name: z.string().trim().min(1).max(200),
        code: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,29}$/, 'Code: 2-30 lowercase letters, digits or dashes'),
        currency: ccy,
        admins: z.array(z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email().max(200) })).min(1).max(20),
    });
    app.post('/api/platform/companies', signedIn(), async (req) => {
        const b = newCompany.parse(req.body);
        if (new Set(b.admins.map(a => a.email)).size !== b.admins.length) throw new HttpError(400, 'Each super administrator needs a different email.', 'validation');
        const pa = req.platformAdmin;
        const created = await tx(app.pg, async c => {
            if ((await c.query('SELECT 1 FROM companies WHERE code=$1', [b.code])).rowCount) throw new HttpError(409, 'This code is already used by another company.', 'duplicate_code');
            if ((await c.query('SELECT 1 FROM companies WHERE lower(name)=lower($1)', [b.name])).rowCount) throw new HttpError(409, 'A company with this name already exists.', 'duplicate_name');
            const co = (await c.query('INSERT INTO companies(code,name,base_currency,created_by) VALUES ($1,$2,$3,$4) RETURNING id', [b.code, b.name, b.currency, pa.id])).rows[0];
            await c.query("INSERT INTO settings(company_id,key,value,updated_by) VALUES ($1,'base_currency',$2,NULL)", [co.id, { currency: b.currency }]);
            // The company's name becomes its first reporting entity
            await c.query('INSERT INTO entities(company_id,code,name,functional_currency) VALUES ($1,$2,$3,$4)', [co.id, b.code.toUpperCase().slice(0, 20), b.name, b.currency]);
            const admins = [];
            for (const a of b.admins) {
                const temp = tempPassword();
                const u = (await c.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,$2,$3,'superadmin',$4) RETURNING id", [co.id, a.email, a.name, await hashPassword(temp)])).rows[0];
                admins.push({ id: u.id, name: a.name, email: a.email, temporaryPassword: temp });
            }
            const detail = { code: b.code, name: b.name, currency: b.currency, superAdmins: b.admins.map(a => a.email), by: pa.email };
            await audit(c, { user: actor(pa), companyId: null, action: 'company.create', objectType: 'company', objectId: co.id, detail, ip: req.ip });
            await audit(c, { user: actor(pa), companyId: co.id, action: 'company.create', objectType: 'company', objectId: co.id, detail, ip: req.ip });
            return { id: co.id, admins };
        });
        // Temporary passwords are returned once; each super administrator must change theirs and set up MFA at first sign-in.
        return { company: (await companyList(app.pg, created.id))[0], superAdmins: created.admins };
    });

    app.patch('/api/platform/companies/:id', signedIn(), async (req) => {
        const id = z.string().uuid().parse(req.params.id);
        const { status } = z.object({ status: z.enum(['active', 'inactive']) }).strict().parse(req.body);
        const pa = req.platformAdmin;
        await tx(app.pg, async c => {
            const co = (await c.query('SELECT * FROM companies WHERE id=$1 FOR UPDATE', [id])).rows[0];
            if (!co) throw new HttpError(404, 'Not found', 'not_found');
            if (co.status === status) return;
            await c.query('UPDATE companies SET status=$2, status_changed_at=now() WHERE id=$1', [id, status]);
            // Deactivation takes effect at once: every request checks the company's status, so open sessions stop
            // working and their users are told why. Those sessions are removed on reactivation, so none comes back.
            let ended = 0;
            if (status === 'inactive') ended = (await c.query(`SELECT count(*)::int n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.company_id = $1`, [id])).rows[0].n;
            else await c.query('DELETE FROM sessions s USING users u WHERE u.id = s.user_id AND u.company_id = $1', [id]);
            const action = status === 'active' ? 'company.activate' : 'company.deactivate';
            const detail = { code: co.code, name: co.name, by: pa.email, sessionsEnded: ended };
            await audit(c, { user: actor(pa), companyId: null, action, objectType: 'company', objectId: id, detail, ip: req.ip });
            await audit(c, { user: actor(pa), companyId: id, action, objectType: 'company', objectId: id, detail, ip: req.ip });
        });
        return (await companyList(app.pg, id))[0];
    });
}
