/* Bringing a company's browser data to the server, once (VITE_USE_API=true).
   The data comes from this browser (the browser-only app, or the original single page, when they ran at
   this address) or from a backup file downloaded from them. It is checked with the server first and
   nothing changes until the person confirms; then, in order: custom roles, settings (entities and rates
   added), people (matched by email, or added with a temporary password), leases (with their changes,
   payments and history), bank statements, batches, ERP files and drafts, and the browser's audit log as
   an archive. Each step goes through the server's own checks and its audit log; running it again adds
   only what is not there yet. */
import { SETTINGS, type AppSettings, type ApprovalPolicy } from './settings';
import { companies, dataKey } from './platform';
import { isBuiltinRole } from './enterprise';
import { chunks, mergeSettings, refreshAll } from './serverBackup';
import { api } from '../api/client';
import { reloadRoles, serverMe, serverRoles } from '../api/auth';
import { checkLeaseImport, importLeases, type ImportCheck } from '../api/leases';
import { restoreRecords } from '../api/records';
import { userSource } from '../components/users/source';
import type { Lease } from '../types/lease';
import type { AuditEntry, RoleDef, UserRecord } from '../types/enterprise';

/** A company's data as the browser app kept it (also the shape of its backups). */
export interface BrowserData {
    settings?: Partial<AppSettings>; leases?: Lease[]; users?: UserRecord[]; roles?: RoleDef[];
    bank?: { id: string; importedBy?: string }[]; batches?: { id: string; createdBy?: string }[];
    exports?: { id: string; createdBy?: string; markedBy?: string }[]; drafts?: { id: string; createdBy?: string; editedBy?: string }[];
    audit?: AuditEntry[];
}
export interface BrowserSource { key: string; label: string; data: BrowserData; migrated?: { at: string; company: string; by: string } }

/* ---- Where the data is ---- */
const MIGRATED = 'ifrs16.migrated';
const read = <T>(key: string): T | undefined => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : undefined; } catch { return undefined; } };
const migratedLog = (): Record<string, BrowserSource['migrated']> => read(MIGRATED) || {};
const NAMES = ['leases', 'settings', 'users', 'roles', 'bank', 'batches', 'exports', 'drafts', 'audit'] as const;
const readAll = (key: (n: string) => string): BrowserData => Object.fromEntries(NAMES.map(n => [n, read(key(n))]).filter(([, v]) => v !== undefined));
const hasData = (d: BrowserData) => !!((d.leases && d.leases.length) || d.settings);

/** Companies with data saved in this browser by the browser-only app, and the original page's data if it was never moved. */
export function browserSources(): BrowserSource[] {
    const log = migratedLog(), out: BrowserSource[] = [];
    for (const c of companies()) { const data = readAll(n => dataKey(c.id, n)); if (hasData(data)) out.push({ key: `company:${c.id}`, label: `${c.name} (browser-only app)`, data, migrated: log[`company:${c.id}`] }); }
    const legacy = readAll(n => 'ifrs16.' + n);
    if (hasData(legacy)) out.push({ key: 'original', label: 'The original lease manager page', data: legacy, migrated: log.original });
    return out;
}
/** A backup file from the browser app (already decrypted). The server's own export is restored from Backups instead. */
export function backupSource(name: string, d: Record<string, unknown>): BrowserSource {
    if (d.format === 'lease-manager-company') throw new Error('This is a backup made on the server. Restore it under Backups and recovery.');
    if (!Array.isArray(d.leases)) throw new Error('This file has no leases.');
    return { key: `file:${name}`, label: name, data: d as BrowserData };
}
const describeSource = (s: BrowserSource) => s.key.startsWith('file:') ? `backup file ${s.label}` : `this browser: ${s.label}`;

/* ---- The check: what would happen, before anything changes ---- */
export interface PersonPlan { user: UserRecord; server?: UserRecord; add: boolean; why?: string }
export interface MigrationPlan {
    source: BrowserSource;
    entitiesToAdd: string[];
    rolesToAdd: RoleDef[];
    people: PersonPlan[];
    leases: ImportCheck;
    records: { bank: number; batches: number; exports: number; drafts: number };
    auditEntries: number;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sameText = (a?: string, b?: string) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

export async function planMigration(source: BrowserSource): Promise<MigrationPlan> {
    const d = source.data, leases = (d.leases || []).filter(l => l && l.id).map(l => ({ ...l, entity: l.entity || (d.settings && d.settings.entity) || SETTINGS.entity }));
    const here = (SETTINGS.entities || []).map(e => e.name);
    const named = [...new Set([...((d.settings && d.settings.entities) || []).map(e => e.name), ...leases.map(l => l.entity)])];
    const users = userSource(); await users.load();
    const seen = new Set<string>(); // one account per email
    const unique = (d.users || []).filter(u => { const e = (u.email || '').trim().toLowerCase(); if ((!e && !u.name) || (e && seen.has(e))) return false; seen.add(e); return true; });
    const people = unique.map(u => {
        const server = users.users().find(s => sameText(s.email, u.email));
        if (server) return { user: u, server, add: false };
        if (!u.email || !EMAIL_RE.test(u.email.trim())) return { user: u, add: false, why: 'No email address, so no account can be made.' };
        return { user: u, add: u.status !== 'disabled', why: u.status === 'disabled' ? 'Disabled in the browser app.' : undefined };
    });
    const check: ImportCheck = { ok: [], existing: [], problems: [] };
    for (const part of chunks(leases)) { const r = await checkLeaseImport(part, describeSource(source)); check.ok.push(...r.ok); check.existing.push(...r.existing); check.problems.push(...r.problems); }
    return {
        source, entitiesToAdd: named.filter(n => n && !here.some(h => sameText(h, n))),
        rolesToAdd: (d.roles || []).filter(r => r.custom && !isBuiltinRole(r.id) && !serverRoles().some(s => sameText(s.label, r.label))),
        people, leases: check,
        records: { bank: (d.bank || []).length, batches: (d.batches || []).length, exports: (d.exports || []).length, drafts: (d.drafts || []).length },
        auditEntries: (d.audit || []).length,
    };
}

/* ---- Bringing it over ---- */
export interface MigrationChoices { settings: boolean; addPeople: Set<string>; replaceExisting: boolean }
export interface StepState { label: string; state: 'waiting' | 'running' | 'done' | 'failed'; note?: string }
export interface MigrationResult { ok: boolean; steps: StepState[]; passwords: { name: string; email: string; password: string }[] }

/** Approvers named in the policy, as roles here that can approve (browser role ids changed to the server's). */
function mapPolicy(p: ApprovalPolicy, roleId: (id: string) => string | undefined): ApprovalPolicy {
    const can = (id: string, type: string) => { const r = serverRoles().find(x => x.id === id); return !!r && (r.perms.includes('approve') || (type === 'draft' && r.perms.includes('ai.approve'))); };
    return Object.fromEntries(Object.entries(p).map(([type, tiers]) => [type, tiers.map(t => {
        const roles = [...new Set(t.roles.map(roleId).filter((r): r is string => !!r && can(r, type)))];
        return { ...t, roles: roles.length ? roles : ['controller', 'admin', 'superadmin'].filter(r => can(r, type)) };
    })])) as ApprovalPolicy;
}

export async function runMigration(plan: MigrationPlan, choices: MigrationChoices, onStep: (steps: StepState[]) => void): Promise<MigrationResult> {
    const d = plan.source.data, source = describeSource(plan.source), passwords: MigrationResult['passwords'] = [];
    const steps: StepState[] = ['Custom roles', 'Settings, entities and rates', 'People', 'Leases', 'Bank statements, batches, ERP files and drafts', 'Audit log archive'].map(label => ({ label, state: 'waiting' }));
    const step = async (i: number, fn: () => Promise<string>) => {
        steps[i] = { ...steps[i], state: 'running' }; onStep(steps.slice());
        try { steps[i] = { ...steps[i], state: 'done', note: await fn() }; onStep(steps.slice()); return true; }
        catch (e) { steps[i] = { ...steps[i], state: 'failed', note: e instanceof Error ? e.message : 'Stopped.' }; onStep(steps.slice()); return false; }
    };
    // Browser ids (roles, people) as the server's
    const roleIds = new Map<string, string>();
    const roleId = (id: string) => isBuiltinRole(id) ? id : roleIds.get(id);
    const userIds = new Map<string, string>();
    const who = (id?: string) => (id && userIds.get(id)) || id;

    let ok = await step(0, async () => {
        for (const r of d.roles || []) { if (!r.custom || isBuiltinRole(r.id)) continue; const s = serverRoles().find(x => sameText(x.label, r.label)); if (s) roleIds.set(r.id, s.id); }
        for (const r of plan.rolesToAdd) { const s = await api.post<{ id: string }>('/roles', { label: r.label, description: r.desc || '', perms: r.perms }); roleIds.set(r.id, s.id); }
        await reloadRoles();
        const changed = (d.roles || []).filter(r => isBuiltinRole(r.id)).length;
        return `${plan.rolesToAdd.length} added` + (changed ? `; ${changed} changed built-in role${changed > 1 ? 's' : ''} left as set here (review under Roles and permissions)` : '');
    });
    if (ok && !choices.settings) { steps[1] = { ...steps[1], state: 'done', note: 'Kept as set here' }; onStep(steps.slice()); }
    else if (ok) ok = await step(1, async () => {
        const settings = d.settings ? { ...d.settings } : undefined;
        if (settings && settings.approvalPolicy) settings.approvalPolicy = mapPolicy(settings.approvalPolicy, roleId);
        if (!await mergeSettings({ settings, leases: d.leases })) throw new Error('The settings were refused (the reason was shown).');
        return `${plan.entitiesToAdd.length} entit${plan.entitiesToAdd.length === 1 ? 'y' : 'ies'} added`;
    });
    if (ok) ok = await step(2, async () => {
        const src = userSource();
        for (const p of plan.people) {
            if (p.server) { userIds.set(p.user.id, p.server.id); continue; }
            if (!choices.addPeople.has(p.user.id)) continue;
            const role = roleId(p.user.role) || 'viewer';
            const r = await src.save(undefined, { ...p.user, id: '', role, status: 'active', email: (p.user.email || '').trim(), extraPerms: (p.user.extraPerms || []) });
            const made = src.users().find(u => sameText(u.email, p.user.email));
            if (made) userIds.set(p.user.id, made.id);
            if (r.temporaryPassword) passwords.push({ name: p.user.name || '', email: p.user.email || '', password: r.temporaryPassword });
        }
        const me = serverMe();
        if (me) userIds.set('local-user', me.user.id); // what the browser app recorded when no one was signed in
        return `${plan.people.filter(p => p.server).length} matched, ${passwords.length} added`;
    });
    if (ok) ok = await step(3, async () => {
        const skip = new Set(plan.leases.problems.map(p => p.id)), existing = new Set(plan.leases.existing);
        const list = (d.leases || []).filter(l => l && l.id && !skip.has(l.id) && (choices.replaceExisting || !existing.has(l.id)))
            .map(l => ({ ...l, entity: l.entity || (d.settings && d.settings.entity) || SETTINGS.entity, history: (l.history || []).map(h => ({ ...h, actor: who(h.actor) || h.actor })) }));
        let n = 0;
        for (const part of chunks(list)) n += (await importLeases(part, source, choices.replaceExisting)).imported.length;
        return `${n} brought over` + (skip.size ? `, ${skip.size} with problems left in the browser` : '') + (!choices.replaceExisting && existing.size ? `, ${existing.size} already here kept` : '');
    });
    if (ok) ok = await step(4, async () => {
        const map = <T extends Record<string, unknown>>(list: T[] | undefined, fields: string[]) => (list || []).map(x => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fields.includes(k) && typeof v === 'string' ? who(v) : v])));
        const sets = { bank: map(d.bank, ['importedBy']), batches: map(d.batches, ['createdBy']), exports: map(d.exports, ['createdBy', 'markedBy']), drafts: map(d.drafts, ['createdBy', 'editedBy']) };
        const counts = { bank: 0, batches: 0, exports: 0, drafts: 0 };
        for (const k of ['bank', 'batches', 'exports', 'drafts'] as const) for (const part of chunks(sets[k])) counts[k] += (await restoreRecords({ source, [k]: part })).restored[k];
        return `${counts.bank} statements, ${counts.batches} batches, ${counts.exports} ERP files, ${counts.drafts} drafts added`;
    });
    if (ok) ok = await step(5, async () => {
        const entries = (d.audit || []).filter(a => a && a.id && a.at && a.action).map(a => ({ id: a.id, at: a.at, actor: who(a.actor), actorName: a.actorName, role: a.role, action: a.action, detail: String(a.detail || '').slice(0, 2000), leaseId: a.leaseId, entity: a.entity }));
        let added = 0;
        for (let i = 0; i < entries.length; i += 2000) for (const part of chunks(entries.slice(i, i + 2000))) added += (await api.post<{ added: number }>('/audit/archive', { source, entries: part })).added;
        return `${added} entries kept`;
    });
    await refreshAll();
    if (ok && !plan.source.key.startsWith('file:')) {
        const me = serverMe();
        try { localStorage.setItem(MIGRATED, JSON.stringify({ ...migratedLog(), [plan.source.key]: { at: new Date().toISOString(), company: me ? me.company.name : '', by: me ? me.user.name : '' } })); } catch { /* storage unavailable */ }
    }
    return { ok, steps, passwords };
}
