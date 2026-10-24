// Administrator command line, run on the server:
//   node src/cli.js create-platform-owner <email> "<name>"   (the SaaS operator; signs in at /platform)
//   node src/cli.js create-company <code> "<name>" [currency]
//   node src/cli.js create-superadmin <company-code> <email> "<name>"
//   node src/cli.js create-entity <company-code> <code> "<name>" <currency>
//   node src/cli.js unlock <email> [company-code]      (clears lockout)
//   node src/cli.js reset-mfa <email> [company-code]   (for a lost phone; the user enrols again)
//   node src/cli.js verify-audit                       (checks every audit hash chain)
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { hashPassword, randomToken } from './security/crypto.js';
import { audit, verifyAllAuditChains } from './audit.js';
import { tx } from './db.js';
const [cmd, ...args] = process.argv.slice(2);
const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
const sys = { id: null, name: 'cli', role: 'system' };
async function companyByCode(code) {
    const c = (await pool.query('SELECT * FROM companies WHERE code=$1', [String(code || '').toLowerCase()])).rows[0];
    if (!c) throw new Error(`No company with code "${code}". Create it with create-company.`);
    return c;
}
try {
    await migrate(pool, { info: () => {} });
    if (cmd === 'create-platform-owner') {
        const [email, name] = args; if (!email || !name) throw new Error('Usage: create-platform-owner <email> "<name>"');
        const temp = randomToken(12) + '!7a';
        await tx(pool, async c => {
            const { rows } = await c.query("INSERT INTO platform_admins(email,name,role,password_hash) VALUES ($1,$2,'owner',$3) RETURNING id", [email, name, await hashPassword(temp)]);
            await audit(c, { user: sys, companyId: null, action: 'platform_admin.create', objectType: 'platform_admin', objectId: rows[0].id, detail: { email, role: 'owner', via: 'cli' } });
        });
        console.log(`Platform owner created.\nTemporary password (shown once): ${temp}\nSign in at /platform, set up the authenticator app, then choose a new password.`);
    } else if (cmd === 'create-company') {
        const [code, name, ccy = 'PKR'] = args;
        if (!code || !name || !/^[A-Z]{3}$/.test(ccy)) throw new Error('Usage: create-company <code> "<name>" [CCY]');
        await tx(pool, async c => {
            const { rows } = await c.query('INSERT INTO companies(code,name,base_currency) VALUES ($1,$2,$3) RETURNING id', [code.toLowerCase(), name, ccy]);
            await c.query("INSERT INTO settings(company_id,key,value) VALUES ($1,'base_currency',$2)", [rows[0].id, { currency: ccy }]);
            await audit(c, { user: sys, companyId: null, action: 'company.create', objectType: 'company', objectId: rows[0].id, detail: { code, name, ccy, via: 'cli' } });
            await audit(c, { user: sys, companyId: rows[0].id, action: 'company.create', objectType: 'company', objectId: rows[0].id, detail: { code, name, ccy, via: 'cli' } });
            console.log('Company created:', rows[0].id);
        });
    } else if (cmd === 'create-superadmin') {
        const [companyCode, email, name] = args; if (!companyCode || !email || !name) throw new Error('Usage: create-superadmin <company-code> <email> "<name>"');
        const co = await companyByCode(companyCode);
        const temp = randomToken(12) + '!7a';
        await tx(pool, async c => {
            const { rows } = await c.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,$2,$3,'superadmin',$4) RETURNING id", [co.id, email, name, await hashPassword(temp)]);
            await audit(c, { user: sys, companyId: co.id, action: 'user.create', objectType: 'user', objectId: rows[0].id, detail: { email, role: 'superadmin', via: 'cli' } });
        });
        console.log(`Super administrator created.\nTemporary password (shown once): ${temp}\nSign in, set up the authenticator app, then choose a new password.`);
    } else if (cmd === 'create-entity') {
        const [companyCode, code, name, ccy] = args; if (!companyCode || !code || !name || !/^[A-Z]{3}$/.test(ccy || '')) throw new Error('Usage: create-entity <company-code> <code> "<name>" <CCY>');
        const co = await companyByCode(companyCode);
        await tx(pool, async c => { const { rows } = await c.query('INSERT INTO entities(company_id,code,name,functional_currency) VALUES ($1,$2,$3,$4) RETURNING id', [co.id, code, name, ccy]); await audit(c, { user: sys, companyId: co.id, action: 'entity.create', objectType: 'entity', objectId: rows[0].id, detail: { code, name, ccy } }); console.log('Entity created:', rows[0].id); });
    } else if (cmd === 'unlock' || cmd === 'reset-mfa') {
        const [email, companyCode] = args;
        const co = companyCode ? await companyByCode(companyCode) : null;
        const found = (await pool.query('SELECT id, company_id FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL AND ($2::uuid IS NULL OR company_id=$2)', [email, co ? co.id : null])).rows;
        if (!found.length) throw new Error('No such user');
        if (found.length > 1) throw new Error('This email is in several companies. Add the company code: ' + cmd + ' <email> <company-code>');
        const u = found[0];
        await tx(pool, async c => {
            const sql = cmd === 'unlock' ? 'UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1' : 'UPDATE users SET mfa_enabled=false, mfa_secret_enc=NULL, mfa_last_step=NULL WHERE id=$1';
            await c.query(sql, [u.id]);
            await c.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
            await audit(c, { user: sys, companyId: u.company_id, action: cmd === 'unlock' ? 'user.unlock' : 'user.reset_mfa', objectType: 'user', objectId: u.id, detail: { via: 'cli' } });
        });
        console.log('Done.');
    } else if (cmd === 'verify-audit') {
        const all = await verifyAllAuditChains(pool);
        const names = Object.fromEntries((await pool.query('SELECT id, code FROM companies')).rows.map(r => [r.id, r.code]));
        for (const r of all) console.log(`${r.companyId ? 'Company ' + (names[r.companyId] || r.companyId) : 'Platform'}: ${r.ok ? `intact (${r.checked} entries)` : `BROKEN at entry ${r.brokenAt}`}`);
        if (!all.length) console.log('No audit entries yet.');
        process.exitCode = all.every(r => r.ok) ? 0 : 2;
    } else console.log('Commands: create-platform-owner, create-company, create-superadmin, create-entity, unlock, reset-mfa, verify-audit');
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await pool.end(); }
