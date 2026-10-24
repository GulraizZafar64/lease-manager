/* ======================================================================
   Enterprise layer: users and roles, approval hierarchy, audit log,
   entities, currencies and exchange rates, period lock.
   Builds on Store (leases and settings) without changing their paths.
   ====================================================================== */
import { EVENT_TYPES, num, run } from './engine';
import { SETTINGS, engineSettings, type ApprovalPolicy, type EntityRecord, type PolicyTier } from './settings';
import { getResult } from './lease';
import { AS_OF, SCOPE, notify } from './state';
import { Store } from './store';
import { companyKey } from './platform';
import { serverMe, serverRoles, serverUserRecord } from '../api/auth';
import { batchesOnServer, statementsOnServer, type ServerBatch } from '../api/banking';
import { CLIENT_ACTIONS, draftsOnServer, exportsOnServer, loadServerAudit, recordClientAction, type ServerDraft } from '../api/records';
import type { ServerAdapter } from '../api/adapter';
import { USE_API } from '../api/client';
import { toast } from '../utils/uiStore';
import { deepClone, fmtNum, uid } from '../utils/format';
import { fmtDate } from '../utils/dates';
import type { Approval, HistoryEntry, Lease, LeaseEvent } from '../types/lease';
import type {
    AccessRequest, AuditEntry, BankStatement, BuiltinRole, DraftRecord, ExportRecord, PaymentBatch, Permission, RoleDef, RoleKey, UserRecord,
} from '../types/enterprise';

export const ROLES: Record<BuiltinRole, { label: string; rank: number; desc: string }> = {
    superadmin: { label: 'Super administrator', rank: 6, desc: 'Everything, including managing administrators and security settings.' },
    admin: { label: 'Administrator', rank: 5, desc: 'Users, entities, policies and settings; all accounting actions.' },
    controller: { label: 'Controller (checker)', rank: 4, desc: 'Approves leases, changes, payment batches and ERP exports within an approval limit.' },
    preparer: { label: 'Lease accountant (maker)', rank: 3, desc: 'Creates and edits leases, submits changes, records payments, imports contracts.' },
    treasury: { label: 'Treasury', rank: 3, desc: 'Bank statements, reconciliation and payment batches.' },
    auditor: { label: 'Auditor', rank: 2, desc: 'Read-only access to everything including the audit log; can export reports.' },
    viewer: { label: 'Viewer', rank: 1, desc: 'Read-only dashboards, register and reports.' },
};

export const PERMS: Record<Permission, string> = {
    'lease.view': 'View leases and reports', 'lease.edit': 'Create and edit leases', 'lease.change': 'Submit remeasurements and modifications', 'lease.delete': 'Delete draft leases',
    'lease.import': 'Import contracts and portfolios', 'approve': 'Approve leases, changes and batches', 'payment.record': 'Record payments and receipts',
    'bank.reconcile': 'Import statements and reconcile', 'payment.batch': 'Create payment batches', 'gl.export': 'Generate ERP / GL exports', 'report.export': 'Export reports and files',
    'audit.view': 'View the audit log', 'admin.users': 'Manage users and roles', 'admin.settings': 'Change settings, entities, rates and policies', 'admin.data': 'Backups, restore, retention and bulk data',
    'period.override': 'Post into a locked period', 'ai.use': 'Use AI features', 'ai.approve': 'Approve AI-drafted disclosures',
};
export const ALL_PERMS = Object.keys(PERMS) as Permission[];
/** Default permissions of the built-in roles (as on the server, lease-manager/src/rbac.js). */
export const ROLE_PERMS: Record<BuiltinRole, Permission[]> = {
    superadmin: ALL_PERMS,
    admin: ALL_PERMS,
    controller: ['lease.view', 'approve', 'report.export', 'audit.view', 'gl.export', 'ai.use', 'ai.approve', 'period.override'],
    preparer: ['lease.view', 'lease.edit', 'lease.change', 'lease.delete', 'lease.import', 'payment.record', 'report.export', 'gl.export', 'ai.use'],
    treasury: ['lease.view', 'payment.record', 'bank.reconcile', 'payment.batch', 'report.export', 'ai.use'],
    auditor: ['lease.view', 'report.export', 'audit.view', 'ai.use'],
    viewer: ['lease.view'],
};
/** Permissions grouped for the Roles and permissions screen. */
export const PERM_GROUPS: [string, Permission[]][] = [
    ['Leases', ['lease.view', 'lease.edit', 'lease.change', 'lease.delete', 'lease.import']],
    ['Approvals and period close', ['approve', 'period.override']],
    ['Payments and banking', ['payment.record', 'bank.reconcile', 'payment.batch']],
    ['Accounting and reporting', ['gl.export', 'report.export', 'audit.view']],
    ['Administration', ['admin.users', 'admin.settings', 'admin.data']],
    ['AI', ['ai.use', 'ai.approve']],
];
export const BUILTIN_ROLES = Object.keys(ROLES) as BuiltinRole[];
export const isBuiltinRole = (r: string): r is BuiltinRole => r in ROLES;

/* ---- Generic collection store: the server (for collections it holds), shared database, or this browser ---- */
export interface Collection<T extends { id: string }> {
    name: string;
    items: T[];
    init(): Promise<void>;
    get(id: string | null | undefined): T | undefined;
    /** Save a document; false (with the reason shown) when the server refused it. */
    save(doc: T): Promise<boolean>;
    remove(id: string): Promise<boolean>;
    /** Read again from the server: other people's changes (nothing to do otherwise). */
    refresh(): Promise<void>;
    on(f: () => void): void;
}
const notSaved = (e: unknown): string => 'Not saved: ' + (e instanceof Error && e.message ? e.message : 'check your connection and try again.');
function Coll<T extends { id: string }>(name: string, server?: ServerAdapter<T>, onLoad?: (items: T[]) => void): Collection<T> {
    const path = `ws/main/${name}`;
    const listeners: (() => void)[] = [];
    // Signed in through the API: what the server last sent, to send only what changed
    let held: T[] = [];
    const onServer = () => !!server && Store.mode === 'api';
    const load = async () => { if (!server) return; held = await server.load(); onLoad?.(held); c.items = deepClone(held); notify(); };
    const c: Collection<T> = {
        name, items: [],
        async init() {
            if (onServer()) { try { await load(); } catch { c.items = []; } return; }
            const db = Store.db;
            if (Store.mode === 'db' && db) {
                await new Promise<void>(res => {
                    let first = true;
                    db.collection(path).onSnapshot(s => { c.items = s.docs.map(d => d.data()).filter(Boolean).map(x => deepClone(x as T)); listeners.forEach(f => f()); if (first) { first = false; res(); } }, () => { if (first) { first = false; res(); } });
                    setTimeout(() => { if (first) { first = false; res(); } }, 6000);
                });
            } else { try { c.items = JSON.parse(localStorage.getItem(companyKey(name)) || '[]'); } catch { c.items = []; } }
        },
        get: id => c.items.find(x => x.id === id),
        async refresh() { if (onServer()) { try { await load(); } catch { /* shown on the next action */ } } },
        async save(doc) {
            if (server && onServer()) {
                try { await server.save(held.find(x => x.id === doc.id), doc); }
                catch (e) { toast(notSaved(e)); await c.refresh(); return false; }
                await c.refresh(); return true;
            }
            const i = c.items.findIndex(x => x.id === doc.id); if (i >= 0) c.items[i] = doc; else c.items.push(doc);
            if (Store.mode === 'db' && Store.db) {
                try { await Store.db.doc(`${path}/${doc.id}`).set(deepClone(doc)); }
                catch (e) { toast(e && typeof e === 'object' && 'code' in e && e.code === 'invalid_argument' ? 'Your sharing level does not allow this change. Ask the page owner to make you an Editor.' : 'Could not save.'); throw e; }
                finally { notify(); }
            } else { try { localStorage.setItem(companyKey(name), JSON.stringify(c.items)); } catch { /* storage unavailable */ } notify(); }
            return true;
        },
        async remove(id) {
            if (server && onServer()) {
                try { await server.remove(id); } catch (e) { toast(notSaved(e)); await c.refresh(); return false; }
                held = held.filter(x => x.id !== id);
            }
            c.items = c.items.filter(x => x.id !== id);
            if (Store.mode === 'db' && Store.db) { try { await Store.db.doc(`${path}/${id}`).delete(); } catch { /* already gone */ } }
            else if (!onServer()) try { localStorage.setItem(companyKey(name), JSON.stringify(c.items)); } catch { /* storage unavailable */ }
            notify();
            return true;
        },
        on(f) { listeners.push(f); },
    };
    return c;
}

export const Ent = {
    users: Coll<UserRecord>('users'),
    /** Changed built-in roles and custom roles; built-ins without a record use their defaults. */
    roles: Coll<RoleDef>('roles'),
    requests: Coll<AccessRequest>('requests'),
    batches: Coll<PaymentBatch>('batches', batchesOnServer, list => list.forEach(b => { const n = (b as ServerBatch).createdByName; if (n) Ent.names[b.createdBy] = n; })),
    exports: Coll<ExportRecord>('exports', exportsOnServer),
    drafts: Coll<DraftRecord>('drafts', draftsOnServer, list => list.forEach(d => { const n = (d as ServerDraft).createdByName; if (n) Ent.names[d.createdBy] = n; })),
    bank: Coll<BankStatement>('bank', statementsOnServer),
    isOwner: false,
    roleOverride: null as RoleKey | null,
    errors: [] as { at: string; msg: string }[],
    started: Date.now(),
    names: {} as Record<string, string>,
};

/* ---- Roles ---- */
function builtinDef(id: BuiltinRole): RoleDef {
    return { id, label: ROLES[id].label, desc: ROLES[id].desc, perms: ROLE_PERMS[id].slice() };
}
/** Every role: built-in roles first (in rank order), then custom roles by name.
    Signed in through the API, the company's roles as saved on the server. */
export function roleDefs(): RoleDef[] {
    const server = serverRoles();
    if (server.length) return server.map(r => ({ id: r.id, label: r.label, desc: r.description, perms: r.perms, custom: r.custom, updatedAt: r.updatedAt || undefined, updatedBy: r.updatedBy || undefined }));
    const saved = (id: string) => Ent.roles.get(id);
    const builtins = BUILTIN_ROLES.map(id => { const d = builtinDef(id), o = saved(id); return o ? { ...d, perms: o.perms.slice(), updatedAt: o.updatedAt, updatedBy: o.updatedBy } : d; });
    const custom = Ent.roles.items.filter(r => r.custom && !isBuiltinRole(r.id)).sort((a, b) => a.label.localeCompare(b.label));
    return builtins.concat(custom);
}
export function roleDef(id: RoleKey | null | undefined): RoleDef | undefined { return id ? roleDefs().find(r => r.id === id) : undefined; }
/** The super administrator always holds every permission; every role can view leases. */
export function rolePerms(id: RoleKey): Permission[] {
    if (id === 'superadmin') return ALL_PERMS.slice();
    const d = roleDef(id);
    return d ? d.perms : [];
}
export const roleLabel = (r: string): string => roleDef(r)?.label ?? r;
/** Whether the built-in role's permissions differ from its defaults. */
export function roleChanged(id: RoleKey): boolean {
    if (!isBuiltinRole(id)) return false;
    const a = rolePerms(id).slice().sort().join(), b = (id === 'superadmin' ? ALL_PERMS : ROLE_PERMS[id]).slice().sort().join();
    return a !== b;
}

/** Record script errors for the System monitor (Administration). */
export function installErrorCapture(): void {
    window.addEventListener('error', e => Ent.errors.push({ at: new Date().toISOString(), msg: String(e.message || e.error) }));
    window.addEventListener('unhandledrejection', e => {
        const r = e.reason as { message?: string; code?: string } | undefined;
        Ent.errors.push({ at: new Date().toISOString(), msg: String((r && (r.message || r.code)) || e.reason) });
    });
}

/* ---- Identity and permissions ---- */
/** The signed-in user: from the server when signed in through the API, else from Users in this browser. */
export function myUser(): UserRecord | undefined { return serverUserRecord() || Ent.users.get(Store.actorId()); }
export function myRole(): RoleKey {
    if (Ent.roleOverride) return Ent.roleOverride;
    const u = myUser();
    // In this browser the role comes from the signed-in user in Users; without one, the original single-user default.
    if (Store.mode !== 'db' && !u) return (SETTINGS.localRole as RoleKey) || 'superadmin';
    if (u && u.status !== 'disabled' && roleDef(u.role)) return u.role;
    return 'viewer';
}
export function realRole(): RoleKey { const o = Ent.roleOverride; Ent.roleOverride = null; const r = myRole(); Ent.roleOverride = o; return r; }
export function setRoleOverride(role: RoleKey | null): void { Ent.roleOverride = role; notify(); }
export function can(p: Permission): boolean {
    const m = serverMe();
    if (m && !Ent.roleOverride) return m.permissions.includes(p); // the server's list; it checks every call again
    const extra = (myUser() || { extraPerms: [] as Permission[] }).extraPerms || [];
    return rolePerms(myRole()).includes(p) || (!Ent.roleOverride && extra.includes(p));
}
/** Props for a control the role may not use. As in the original page, such controls get
    `hidden` and `disabled`; styled controls (.btn, .nav-link) stay visible but disabled. */
export const gate = (p: Permission): { hidden?: boolean; disabled?: boolean } => can(p) ? {} : { hidden: true, disabled: true };
export function guard(p: Permission, what?: string): boolean {
    if (can(p)) return true;
    toast(`Your role (${roleLabel(myRole())}) cannot ${what || PERMS[p].toLowerCase()}.`);
    return false;
}
export function entityAllowed(name: string): boolean {
    const u = myUser(); if (!u || !u.entities || !u.entities.length) return true;
    return u.entities.includes(name);
}
export function inScope(l: Lease): boolean { return entityAllowed(l.entity) && (!SCOPE.entity || l.entity === SCOPE.entity); }
export async function resolveNames(ids: string[]): Promise<void> {
    ids = [...new Set(ids.filter(Boolean))].filter(i => !(i in Ent.names));
    if (!ids.length || !Store.user) return;
    try { const ps = await Store.user.profiles(ids); Object.values(ps).forEach(p => { Ent.names[p.id] = p.name || ''; }); } catch { /* names stay unknown */ }
}
export const nameOf = (id: string): string => id === Store.actorId() ? Store.actorName() : (Ent.names[id] || (Ent.users.get(id) || { name: '' }).name || (Ent.users.get(id) || { label: '' }).label || 'Unknown user');

/* ---- Audit log (organisation-wide, append-only in the app) ---- */
export async function audit(action: string, detail: string, refs: { leaseId?: string; entity?: string } = {}): Promise<void> {
    // Signed in through the API the server keeps the log: it records every change itself; only what the browser alone sees is sent
    if (USE_API) { if (CLIENT_ACTIONS.has(action)) await recordClientAction(action, String(detail || ''), refs.leaseId).catch(() => { /* best effort */ }); return; }
    const e: AuditEntry = Object.assign({ id: new Date().toISOString().replace(/\D/g, '').slice(0, 17) + uid('-'), at: new Date().toISOString(), actor: Store.actorId(), actorName: Store.actorName(), role: myRole(), action, detail: String(detail || '').slice(0, 600) }, refs);
    if (Store.mode === 'db' && Store.db) { try { await Store.db.doc(`ws/main/audit/${e.id}`).set(e); } catch { /* best effort */ } }
    else { try { const a = JSON.parse(localStorage.getItem(companyKey('audit')) || '[]'); a.push(e); localStorage.setItem(companyKey('audit'), JSON.stringify(a.slice(-5000))); } catch { /* storage unavailable */ } }
}
export async function loadAudit(limit = 1000): Promise<AuditEntry[]> {
    if (Store.mode === 'api') { try { return await loadServerAudit(limit); } catch { return []; } }
    if (Store.mode === 'db' && Store.db) { try { const s = await Store.db.collection('ws/main/audit').orderBy('at', 'desc').limit(limit).get(); return s.docs.map(d => d.data() as AuditEntry); } catch { return []; } }
    try { return (JSON.parse(localStorage.getItem(companyKey('audit')) || '[]') as AuditEntry[]).reverse().slice(0, limit); } catch { return []; }
}
/** Add an entry to the lease's history; every entry is mirrored to the organisation audit log. */
export function logHistory(l: Lease, text: string, extra: Partial<HistoryEntry> = {}): void {
    l.history = l.history || [];
    l.history.push(Object.assign({ at: new Date().toISOString(), actor: Store.actorId(), actorName: Store.actorName(), text }, extra));
    audit('lease', text, { leaseId: l.id, entity: l.entity });
}

/* ---- Entities ---- */
export function entities(): EntityRecord[] {
    if (!Array.isArray(SETTINGS.entities) || !SETTINGS.entities.length) SETTINGS.entities = [{ name: SETTINGS.entity, code: 'E01', functionalCurrency: SETTINGS.functionalCurrency, parent: '', country: 'Pakistan' }];
    const list = SETTINGS.entities;
    for (const l of Store.all) if (l.entity && !list.find(e => e.name === l.entity)) list.push({ name: l.entity, code: 'E' + String(list.length + 1).padStart(2, '0'), functionalCurrency: SETTINGS.functionalCurrency, parent: list[0].name, country: '' });
    return list;
}
export const entityOf = (name: string): EntityRecord => entities().find(e => e.name === name) || entities()[0];

/* ---- Exchange rates ----
   Rates are stored as units of the group base currency (SETTINGS.functionalCurrency) per 1 unit of each currency.
   fxHistory holds dated closing rates; the latest date on or before a date applies. */
export const FX_MISSING = new Set<string>();
export function baseRate(ccy: string, date?: string): number {
    if (ccy === SETTINGS.functionalCurrency) return 1;
    const hist = (SETTINGS.fxHistory || []).filter(h => h.date <= (date || AS_OF) && num(h.rates[ccy])).sort((a, b) => b.date.localeCompare(a.date));
    if (hist.length) return num(hist[0].rates[ccy]);
    const r = num(SETTINGS.fx[ccy]); if (r) return r;
    FX_MISSING.add(ccy); return 0;
}
export function averageRate(ccy: string, from: string, to: string): number {
    if (ccy === SETTINGS.functionalCurrency) return 1;
    const pts = (SETTINGS.fxHistory || []).filter(h => h.date >= from && h.date <= to && num(h.rates[ccy])).map(h => num(h.rates[ccy]));
    return pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : baseRate(ccy, to);
}
export function presentationCcy(): string { return SETTINGS.presentationCurrency || SETTINGS.functionalCurrency; }
export function fxConvert(amount: number, ccy: string, date?: string): number {
    const P = presentationCcy(), rc = baseRate(ccy, date), rp = baseRate(P, date);
    if (!rc || !rp) return 0;
    return amount * rc / rp;
}
export const toFunctional = (amount: number, ccy: string): number => fxConvert(amount, ccy, AS_OF);
export const crossRate = (from: string, to: string, date?: string): number => { const a = baseRate(from, date), b = baseRate(to, date); return a && b ? a / b : 0; };
export function fxConvertBase(v: number, ccy: string): number { const r = baseRate(ccy, AS_OF); return r ? v * r : 0; }

/* ---- Approval hierarchy ----
   Policy tiers per item type, by amount in the base currency. Each tier needs N distinct approvers
   holding one of the roles, none of whom prepared the item, each with a limit at least the amount. */
export const DEFAULT_POLICY: ApprovalPolicy = {
    lease: [{ upTo: 100000000, approvals: 1, roles: ['controller', 'admin', 'superadmin'] }, { upTo: null, approvals: 2, roles: ['controller', 'admin', 'superadmin'] }],
    change: [{ upTo: 25000000, approvals: 1, roles: ['controller', 'admin', 'superadmin'] }, { upTo: null, approvals: 2, roles: ['controller', 'admin', 'superadmin'] }],
    batch: [{ upTo: 10000000, approvals: 1, roles: ['controller', 'admin', 'superadmin'] }, { upTo: null, approvals: 2, roles: ['controller', 'admin', 'superadmin'] }],
    export: [{ upTo: null, approvals: 1, roles: ['controller', 'admin', 'superadmin'] }],
    draft: [{ upTo: null, approvals: 1, roles: ['controller', 'admin', 'superadmin'] }],
};
export type PolicyType = keyof ApprovalPolicy;
export function policy(): ApprovalPolicy {
    if (!SETTINGS.approvalPolicy) SETTINGS.approvalPolicy = deepClone(DEFAULT_POLICY);
    const p = SETTINGS.approvalPolicy;
    (Object.keys(DEFAULT_POLICY) as PolicyType[]).forEach(k => { if (!p[k]) p[k] = deepClone(DEFAULT_POLICY[k]); });
    return p;
}
export function tierFor(type: PolicyType, amount: number): PolicyTier {
    const tiers = policy()[type] || [];
    return tiers.find(t => t.upTo === null || t.upTo === '' || Math.abs(amount) <= num(t.upTo)) || tiers[tiers.length - 1] || { upTo: null, approvals: 1, roles: ['controller', 'admin', 'superadmin'] };
}
export function leaseAmount(l: Lease): number {
    const r = getResult(l); if (!r) return 0;
    const v = r.mode === 'lessee' ? r.initial.liability : r.mode === 'lessor-finance' ? r.initial.netInvestment : r.initial.total;
    return Math.abs(fxConvertBase(v, l.currency));
}
export function eventAmount(l: Lease, ev: LeaseEvent): number {
    const t = deepClone(l); t.status = 'active'; t.events = t.events.map(e => e.id === ev.id ? Object.assign({}, e, { status: 'approved' as const }) : e);
    try {
        const r = run(t, engineSettings());
        const e = (r.events as { id: string; adjustment?: number; partial?: { gain: number }; before: { L?: number } }[]).find(x => x.id === ev.id);
        if (!e) return 0;
        return Math.abs(fxConvertBase(Math.abs(e.adjustment || 0) + Math.abs((e.partial && e.partial.gain) || 0) + (ev.type === 'terminate' ? Math.abs(e.before.L ?? NaN) : 0) + (ev.type === 'impair' ? num(ev.amount) : 0), l.currency));
    } catch { return 0; }
}
export interface ApprovalCheck { ok: boolean; reason?: string; tier?: PolicyTier; needed: number; done: boolean }
export function checkApproval(type: PolicyType, item: { approvals?: Approval[] }, amount: number, preparer?: string): ApprovalCheck {
    const tier = tierFor(type, amount), me = Store.actorId(), role = myRole(), u = myUser();
    const approvals = item.approvals || [];
    const needed = num(tier.approvals) || 1;
    const no = (reason: string): ApprovalCheck => ({ ok: false, reason, needed, done: false });
    if (!can('approve') && !(type === 'draft' && can('ai.approve'))) return no('Your role cannot approve.');
    if (!tier.roles.includes(role)) return no(`This amount needs approval by ${tier.roles.map(r => roleLabel(r)).join(' or ')}.`);
    if (SETTINGS.segregateApproval && (Store.mode === 'db' || myUser()) && preparer && preparer === me) return no('You prepared this item. Segregation of duties requires a different approver.');
    if (approvals.some(a => a.by === me)) return no('You have already approved this item; another approver is needed.');
    if (u && num(u.limit) && amount > num(u.limit)) return no(`The amount ${fmtNum(amount)} exceeds your approval limit of ${fmtNum(u.limit)}.`);
    return { ok: true, tier, needed, done: approvals.length + 1 >= needed };
}
export function approvalProgress(item: { approvals?: Approval[] }, type: PolicyType, amount: number): string {
    const t = tierFor(type, amount);
    return `${(item.approvals || []).length} of ${t.approvals} approval${t.approvals > 1 ? 's' : ''} (${t.roles.map(r => roleLabel(r)).join(' / ')})`;
}
/** The approval record for the current user. */
export const myApproval = (): Approval => ({ by: Store.actorId(), name: Store.actorName(), role: myRole(), at: new Date().toISOString() });

/* ---- Period lock ---- */
export function periodLocked(date: string | null | undefined): boolean { return !!(SETTINGS.lockedThrough && date && date <= SETTINGS.lockedThrough); }
export function lockGuard(date: string, what: string): boolean {
    if (!periodLocked(date)) return true;
    if (can('period.override')) {
        if (confirm(`${fmtDate(date)} is in a closed period (locked to ${fmtDate(SETTINGS.lockedThrough)}). Post anyway with your override permission? This is recorded in the audit log.`)) { audit('period.override', `${what} dated ${date} posted into locked period`); return true; }
        return false;
    }
    toast(`${fmtDate(date)} is in a closed period (locked to ${fmtDate(SETTINGS.lockedThrough)}). Use a date in an open period.`);
    return false;
}

export const eventLabel = (type: string): string => (EVENT_TYPES as Record<string, { label: string }>)[type]?.label ?? type;
