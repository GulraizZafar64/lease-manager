import { z } from 'zod';
import { hashPassword, verifyPassword, dummyVerify, passwordProblems, encrypt, decrypt, randomToken, sha256 } from './security/crypto.js';
import { newSecret, verifyTotp, otpauthUrl } from './security/totp.js';
import { HttpError, can, forbid, permissionsOf } from './rbac.js';
import { audit } from './audit.js';
import { tx } from './db.js';

export const COOKIE = 'lm_session';

// A user with their company (every user belongs to exactly one company).
// With the company's saved permissions for the user's role (none: the built-in default).
const USER_SQL = `SELECT u.*, c.code AS company_code, c.name AS company_name, c.status AS company_status, c.base_currency AS company_currency, r.perms AS role_perms
    FROM users u JOIN companies c ON c.id = u.company_id LEFT JOIN roles r ON r.company_id = u.company_id AND r.id = u.role`;
async function loadUser(db, id) {
    const u = (await db.query(`${USER_SQL} WHERE u.id=$1`, [id])).rows[0];
    if (!u) return null;
    u.entityIds = (await db.query('SELECT entity_id FROM user_entities WHERE user_id=$1', [id])).rows.map(r => r.entity_id);
    return u;
}
export const publicCompany = u => ({ id: u.company_id, code: u.company_code, name: u.company_name, status: u.company_status, currency: u.company_currency });
export const publicUser = u => u && ({
    id: u.id, companyId: u.company_id, email: u.email, name: u.name, title: u.title, role: u.role, status: u.status, extraPerms: u.extra_perms || [],
    mfaEnabled: u.mfa_enabled, mustChangePassword: u.must_change_password, approvalLimit: u.approval_limit, entityIds: u.entityIds || [],
    lockedUntil: u.locked_until, lastLoginAt: u.last_login_at, createdAt: u.created_at,
});

// Session lookup on every request (cookie token -> SHA-256 -> sessions row)
export function sessionHook(app, cfg) {
    app.decorateRequest('user', null);
    app.decorateRequest('session', null);
    app.addHook('onRequest', async (req) => {
        // Cross-site request forgery: state-changing calls must carry our header (browsers cannot add it cross-site without CORS, which is off)
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.url.startsWith('/api/') && req.headers['x-requested-with'] !== 'lease-manager') throw new HttpError(403, 'Missing request header', 'csrf');
        const token = req.cookies[COOKIE];
        if (!token) return;
        const h = sha256(token);
        const s = (await app.pg.query('SELECT * FROM sessions WHERE token_hash=$1', [h])).rows[0];
        // A cookie whose session is gone: timed out, or ended (password changed, MFA failures, company deactivated)
        if (!s) { req.endedAs = 'session_expired'; return; }
        const now = Date.now();
        if (new Date(s.expires_at) < now || now - new Date(s.last_seen) > cfg.idleMinutes * 60000) { await app.pg.query('DELETE FROM sessions WHERE token_hash=$1', [h]); req.endedAs = 'session_expired'; return; }
        const u = await loadUser(app.pg, s.user_id);
        if (!u || u.deleted_at || u.status !== 'active') { req.endedAs = 'account_disabled'; return; }
        if (u.company_status !== 'active') { req.endedAs = 'company_inactive'; return; }
        if (now - new Date(s.last_seen) > 60000) await app.pg.query('UPDATE sessions SET last_seen=now() WHERE token_hash=$1', [h]);
        req.session = s; req.user = u;
    });
}
// Why there is no signed-in user, so the client can say why the session ended.
const ENDED = {
    session_expired: 'Your session has expired. Sign in again.',
    account_disabled: 'Your account has been disabled. Ask an administrator of your company.',
    company_inactive: 'Your company’s account is inactive. Contact your service provider.',
};
const noUser = req => req.endedAs ? new HttpError(401, ENDED[req.endedAs], req.endedAs) : new HttpError(401, 'Sign in required', 'unauthenticated');

// Route guard: signed in, MFA passed, password current, and holding the permission
export function requireAuth(cfg, perm, { allowPasswordChange = false, allowNoMfa = false } = {}) {
    return async (req) => {
        if (!req.user) throw noUser(req);
        if (!allowNoMfa && !req.session.mfa_passed) throw new HttpError(401, 'Multi-factor verification required', 'mfa_required');
        if (!allowPasswordChange && req.user.must_change_password) throw new HttpError(403, 'Change your password to continue', 'password_change_required');
        if (perm && !can(req.user, perm)) throw forbid();
    };
}

export function authRoutes(app, cfg) {
    // "Keep me signed in" off: a browser-session cookie, gone when the browser closes (the server limits still apply)
    const setCookie = (reply, token, remember) => reply.setCookie(COOKIE, token, { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict', path: '/', ...(remember ? { maxAge: cfg.sessionHours * 3600 } : {}) });

    // Sign-in. The same email may exist in several companies, each account with its own password:
    // when the password opens more than one, the client chooses a company and signs in again with companyId.
    app.post('/api/auth/login', async (req, reply) => {
        const { email, password, companyId, remember } = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200), companyId: z.string().uuid().optional(), remember: z.boolean().default(true) }).parse(req.body);
        const candidates = (await app.pg.query(`${USER_SQL} WHERE lower(u.email)=lower($1) AND u.deleted_at IS NULL AND ($2::uuid IS NULL OR u.company_id=$2) ORDER BY c.name`, [email, companyId || null])).rows;
        const bad = () => new HttpError(401, 'Email or password is incorrect, or the account is locked.', 'bad_credentials'); // same message for every case
        if (!candidates.length) { await dummyVerify(password); throw bad(); }
        const opened = [], failed = [];
        for (const u of candidates) {
            const why = u.locked_until && new Date(u.locked_until) > new Date() ? 'locked' : u.status !== 'active' ? 'disabled' : null;
            if (why) { await dummyVerify(password); failed.push([u, why]); continue; }
            if (await verifyPassword(password, u.password_hash)) opened.push(u); else failed.push([u, 'password']);
        }
        if (!opened.length) {
            // Count the failure against each account the email could mean
            for (const [u, why] of failed) await tx(app.pg, async c => {
                const n = u.failed_logins + 1, lock = n >= cfg.maxFailedLogins;
                await c.query('UPDATE users SET failed_logins=$2, locked_until=$3 WHERE id=$1', [u.id, lock ? 0 : n, lock ? new Date(Date.now() + cfg.lockMinutes * 60000) : u.locked_until]);
                await audit(c, { user: u, action: lock ? 'auth.locked' : 'auth.failed', objectType: 'user', objectId: u.id, detail: { why }, ip: req.ip });
            });
            throw bad();
        }
        // The password is right, so saying the company is inactive reveals nothing new.
        const usable = opened.filter(u => u.company_status === 'active');
        if (!usable.length) throw new HttpError(403, 'Your company’s account is inactive. Contact your service provider.', 'company_inactive');
        if (usable.length > 1) return { next: 'choose_company', companies: usable.map(u => ({ id: u.company_id, code: u.company_code, name: u.company_name })) };
        const u = usable[0];
        const token = randomToken();
        // REQUIRE_MFA=false: no code is asked, from anyone; authenticator keys stay saved for when it is switched back on
        const mfaPassed = !cfg.requireMfa;
        await tx(app.pg, async c => {
            await c.query(`UPDATE users SET failed_logins=0, locked_until=NULL${mfaPassed ? ', last_login_at=now()' : ''} WHERE id=$1`, [u.id]);
            await c.query('INSERT INTO sessions(token_hash,user_id,mfa_passed,expires_at,ip,user_agent) VALUES ($1,$2,$3,$4,$5,$6)', [sha256(token), u.id, mfaPassed, new Date(Date.now() + cfg.sessionHours * 3600000), req.ip, String(req.headers['user-agent'] || '').slice(0, 300)]);
            await audit(c, { user: u, action: 'auth.password_ok', objectType: 'user', objectId: u.id, ip: req.ip });
        });
        setCookie(reply, token, remember);
        return { next: mfaPassed ? (u.must_change_password ? 'change_password' : 'done') : u.mfa_enabled ? 'mfa_verify' : 'mfa_enrol', mustChangePassword: u.must_change_password, company: publicCompany(u) };
    });

    // Enrolment: a new secret is generated and held encrypted until the first code proves the user has it
    app.post('/api/auth/mfa/setup', { preHandler: requireAuth(cfg, null, { allowNoMfa: true, allowPasswordChange: true }) }, async (req) => {
        if (req.user.mfa_enabled) throw new HttpError(409, 'MFA is already set up. An administrator can reset it.', 'mfa_exists');
        const secret = newSecret();
        await app.pg.query('UPDATE users SET mfa_secret_enc=$2 WHERE id=$1', [req.user.id, encrypt(secret, cfg.masterKey)]);
        return { secret, otpauthUrl: otpauthUrl(secret, `${req.user.email} (${req.user.company_name})`, cfg.orgName) };
    });
    app.post('/api/auth/mfa/verify', { preHandler: requireAuth(cfg, null, { allowNoMfa: true, allowPasswordChange: true }) }, async (req) => {
        const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
        const u = req.user;
        if (!u.mfa_secret_enc) throw new HttpError(409, 'Set up MFA first', 'mfa_not_setup');
        const step = verifyTotp(decrypt(u.mfa_secret_enc, cfg.masterKey), code, { lastStep: u.mfa_last_step === null ? null : Number(u.mfa_last_step) });
        if (step === null) {
            await tx(app.pg, async c => {
                const n = u.failed_logins + 1, lock = n >= cfg.maxFailedLogins;
                await c.query('UPDATE users SET failed_logins=$2, locked_until=$3 WHERE id=$1', [u.id, lock ? 0 : n, lock ? new Date(Date.now() + cfg.lockMinutes * 60000) : null]);
                if (lock) await c.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
                await audit(c, { user: u, action: lock ? 'auth.locked' : 'auth.mfa_failed', objectType: 'user', objectId: u.id, ip: req.ip });
            });
            throw new HttpError(401, 'That code is not valid.', 'bad_code');
        }
        await tx(app.pg, async c => {
            await c.query('UPDATE users SET mfa_enabled=true, mfa_last_step=$2, failed_logins=0, last_login_at=now() WHERE id=$1', [u.id, step]);
            await c.query('UPDATE sessions SET mfa_passed=true WHERE token_hash=$1', [req.session.token_hash]);
            await audit(c, { user: u, action: u.mfa_enabled ? 'auth.mfa_ok' : 'auth.mfa_enrolled', objectType: 'user', objectId: u.id, ip: req.ip });
        });
        return { next: u.must_change_password ? 'change_password' : 'done' };
    });

    app.post('/api/auth/password', { preHandler: requireAuth(cfg, null, { allowPasswordChange: true }) }, async (req) => {
        const { current, next } = z.object({ current: z.string().max(200), next: z.string().max(200) }).parse(req.body);
        if (!(await verifyPassword(current, req.user.password_hash))) throw new HttpError(400, 'Current password is incorrect.', 'bad_password');
        const probs = passwordProblems(next, cfg.passwordMinLength, [req.user.name, req.user.email.split('@')[0]]);
        if (probs.length) throw new HttpError(400, 'Choose a password with ' + probs.join(', ') + '.', 'weak_password');
        if (await verifyPassword(next, req.user.password_hash)) throw new HttpError(400, 'Choose a password different from the current one.', 'same_password');
        await tx(app.pg, async c => {
            await c.query('UPDATE users SET password_hash=$2, must_change_password=false, password_changed_at=now() WHERE id=$1', [req.user.id, await hashPassword(next)]);
            await c.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [req.user.id, req.session.token_hash]); // sign out other devices
            await audit(c, { user: req.user, action: 'auth.password_changed', objectType: 'user', objectId: req.user.id, ip: req.ip });
        });
        return { ok: true };
    });
    app.post('/api/auth/logout', async (req, reply) => {
        if (req.session) { await app.pg.query('DELETE FROM sessions WHERE token_hash=$1', [req.session.token_hash]); await tx(app.pg, c => audit(c, { user: req.user, action: 'auth.logout', objectType: 'user', objectId: req.user.id, ip: req.ip })); }
        reply.clearCookie(COOKIE, { path: '/' });
        return { ok: true };
    });
    app.get('/api/auth/me', async (req) => {
        if (!req.user) throw noUser(req);
        return { user: publicUser(req.user), company: publicCompany(req.user), mfaPassed: req.session.mfa_passed, permissions: permissionsOf(req.user) };
    });
    // The person's other companies (same email, active account, active company), for Switch company.
    // Switching signs in again: each account has its own password and MFA.
    app.get('/api/auth/companies', { preHandler: requireAuth(cfg, null) }, async (req) => {
        const { rows } = await app.pg.query(`SELECT c.id, c.code, c.name, u.role FROM users u JOIN companies c ON c.id = u.company_id
            WHERE lower(u.email)=lower($1) AND u.company_id<>$2 AND u.status='active' AND u.deleted_at IS NULL AND c.status='active' ORDER BY c.name`, [req.user.email, req.user.company_id]);
        return rows;
    });
}
export { loadUser };
