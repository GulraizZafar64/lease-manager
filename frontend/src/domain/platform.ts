/* SaaS platform layer, user interface only (no server yet).
   The platform owner adds companies; each company has its own users, roles,
   leases, settings and audit log, stored apart under ifrs16.c.<company>.<name>.
   A server will need a company id on every table and company-aware sign-in. */
import { getSession } from './session';
import { notify } from './state';
import { serverMe } from '../api/auth';
import type { AuditEntry, UserRecord } from '../types/enterprise';

export type CompanyStatus = 'active' | 'inactive';
export interface Company {
    id: string; name: string; code: string; currency: string; createdAt: string; createdBy: string; demo?: boolean;
    /** Inactive companies keep their data, but their users cannot sign in. Missing means active. */
    status?: CompanyStatus; statusChangedAt?: string;
}
export interface Account { company: Company; user: UserRecord }
export interface NewCompany { name: string; code: string; currency: string; admins: { name: string; email: string }[] }

/** The platform owner (you). Placeholder details until platform sign-in is on a server. */
export const PLATFORM_OWNER = { name: 'Platform Owner', email: 'owner@example.com' };

export const REGISTRY = 'ifrs16.platform.companies';
const PLATFORM_AUDIT = 'ifrs16.platform.audit';
const PLATFORM_SESSION = 'ifrs16.platform.session';
/** Per-company data, as named by the app before companies existed. */
const COMPANY_DATA = ['leases', 'settings', 'audit', 'users', 'roles', 'requests', 'batches', 'exports', 'drafts', 'bank'];

function read<T>(key: string, fallback: T): T {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}
function write(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export const dataKey = (companyId: string, name: string): string => `ifrs16.c.${companyId}.${name}`;
/** Storage key for the signed-in company's data. */
export function companyKey(name: string): string {
    const s = getSession();
    return s ? dataKey(s.companyId, name) : 'ifrs16.' + name;
}

export const companies = (): Company[] => read<Company[]>(REGISTRY, []);
export const companyById = (id: string | null | undefined): Company | undefined => companies().find(c => c.id === id);
export const isCompanyActive = (c: Company | undefined): boolean => !!c && c.status !== 'inactive';
export const currentCompany = (): Company | undefined => {
    const m = serverMe();
    if (m) return { id: m.company.id, name: m.company.name, code: m.company.code, currency: m.company.currency, status: m.company.status, createdAt: '', createdBy: '' };
    const s = getSession(); return s ? companyById(s.companyId) : undefined;
};
export const companyUsers = (id: string): UserRecord[] => read<UserRecord[]>(dataKey(id, 'users'), []);
export const companyLeaseCount = (id: string): number => read<unknown[]>(dataKey(id, 'leases'), []).length;

/** Every account with this email, across companies. */
export function findAccounts(email: string): Account[] {
    const e = email.trim().toLowerCase();
    return companies().flatMap(company => companyUsers(company.id).filter(u => (u.email || '').toLowerCase() === e).map(user => ({ company, user })));
}
/** Active accounts for the demo list on the login page. */
export const allActiveAccounts = (): Account[] => companies().filter(isCompanyActive).flatMap(company => companyUsers(company.id).filter(u => u.email && u.status === 'active').map(user => ({ company, user })));

/** Starter users of the demo company, one or more per role. */
const DEMO_USERS: Omit<UserRecord, 'addedAt' | 'addedBy'>[] = [
    { id: 'u-alex', name: 'Alex Morgan', email: 'alex.morgan@example.com', title: 'Finance Director', role: 'superadmin', status: 'active' },
    { id: 'u-priya', name: 'Priya Shah', email: 'priya.shah@example.com', title: 'Systems Administrator', role: 'admin', status: 'active' },
    { id: 'u-daniel', name: 'Daniel Okafor', email: 'daniel.okafor@example.com', title: 'Financial Controller', role: 'controller', status: 'active', limit: 150000000 },
    { id: 'u-mei', name: 'Mei Lin', email: 'mei.lin@example.com', title: 'Lease Accountant', role: 'preparer', status: 'active' },
    { id: 'u-omar', name: 'Omar Haddad', email: 'omar.haddad@example.com', title: 'Treasury Analyst', role: 'treasury', status: 'active' },
    { id: 'u-sofia', name: 'Sofia Rossi', email: 'sofia.rossi@example.com', title: 'External Auditor', role: 'auditor', status: 'active' },
    { id: 'u-liam', name: 'Liam Walsh', email: 'liam.walsh@example.com', title: 'Business Analyst', role: 'viewer', status: 'active' },
    { id: 'u-noah', name: 'Noah Becker', email: 'noah.becker@example.com', title: 'Former Lease Accountant', role: 'preparer', status: 'disabled' },
];

/** First run in this browser: the existing workspace becomes the demo company, with its starter users. */
export function ensureCompanies(): void {
    let list: Company[];
    try { if (localStorage.getItem(REGISTRY)) list = companies(); else list = []; } catch { return; }
    if (!list.length) {
        const at = new Date().toISOString();
        const legacy = read<{ functionalCurrency?: string }>('ifrs16.settings', {});
        list = [{ id: 'demo', name: 'Demo Company', code: 'demo', currency: legacy.functionalCurrency || 'PKR', createdAt: at, createdBy: 'system', demo: true }];
        try {
            for (const n of COMPANY_DATA) { const v = localStorage.getItem('ifrs16.' + n); if (v !== null) { localStorage.setItem(dataKey('demo', n), v); localStorage.removeItem('ifrs16.' + n); } }
            Object.keys(localStorage).filter(k => k.startsWith('ifrs16.widgets.')).forEach(k => { localStorage.setItem(dataKey('demo', k.slice(7)), localStorage.getItem(k) || ''); localStorage.removeItem(k); });
        } catch { /* storage unavailable */ }
        write(REGISTRY, list);
    }
    const demo = list.find(c => c.demo);
    if (demo && !companyUsers(demo.id).some(u => u.email)) {
        const at = new Date().toISOString();
        write(dataKey(demo.id, 'users'), companyUsers(demo.id).concat(DEMO_USERS.map(u => ({ ...u, addedAt: at, addedBy: 'system' }))));
    }
}

export const slug = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Problems with the fields of a new company, by field ('' means the whole form). */
export function companyFieldProblems(c: NewCompany): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!c.name.trim()) errs.name = 'Enter the company name.';
    if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(slug(c.code))) errs.code = 'Enter a short code of 2-30 letters, numbers or dashes.';
    if (!c.admins.length) errs[''] = 'Add at least one super administrator.';
    const seen = new Set<string>();
    c.admins.forEach((a, i) => {
        if (!a.name.trim()) errs[`name${i}`] = 'Enter a name.';
        const e = a.email.trim().toLowerCase();
        if (!e) errs[`email${i}`] = 'Enter an email.';
        else if (!EMAIL_RE.test(e)) errs[`email${i}`] = 'Enter a valid email.';
        else if (seen.has(e)) errs[`email${i}`] = 'Each super administrator needs a different email.';
        seen.add(e);
    });
    return errs;
}
/** Field problems plus duplicates among the companies kept in this browser. */
export function companyProblems(c: NewCompany): Record<string, string> {
    const errs = companyFieldProblems(c);
    if (!errs.name && companies().some(x => x.name.toLowerCase() === c.name.trim().toLowerCase())) errs.name = 'A company with this name already exists.';
    if (!errs.code && companyById(slug(c.code))) errs.code = 'This code is already used by another company.';
    return errs;
}

function platformAudit(action: string, detail: string): AuditEntry {
    const e: AuditEntry = { id: new Date().toISOString().replace(/\D/g, '').slice(0, 17) + '-' + Math.random().toString(36).slice(2, 7), at: new Date().toISOString(), actor: 'platform-owner', actorName: PLATFORM_OWNER.name, role: 'Platform owner', action, detail };
    write(PLATFORM_AUDIT, read<AuditEntry[]>(PLATFORM_AUDIT, []).concat([e]).slice(-2000));
    return e;
}
export const platformAuditLog = (): AuditEntry[] => read<AuditEntry[]>(PLATFORM_AUDIT, []).slice().reverse();

/** Create a company with its super administrators; its other data starts empty. */
export function createCompany(c: NewCompany): Company {
    const at = new Date().toISOString();
    const company: Company = { id: slug(c.code), name: c.name.trim(), code: slug(c.code), currency: c.currency, createdAt: at, createdBy: PLATFORM_OWNER.email };
    const admins: UserRecord[] = c.admins.map((a, i) => ({ id: `u-${company.id}-${i + 1}-${Math.random().toString(36).slice(2, 6)}`, name: a.name.trim(), email: a.email.trim().toLowerCase(), role: 'superadmin', status: 'active', title: 'Super administrator', addedAt: at, addedBy: 'platform' }));
    write(dataKey(company.id, 'users'), admins);
    write(dataKey(company.id, 'settings'), { entity: company.name, functionalCurrency: company.currency });
    const entry = platformAudit('company.create', `Company ${company.name} (${company.code}) created with super administrators ${admins.map(a => a.email).join(', ')}`);
    write(dataKey(company.id, 'audit'), [{ ...entry, detail: `Company created by the platform owner; super administrators: ${admins.map(a => `${a.name} (${a.email})`).join(', ')}` }]);
    write(REGISTRY, companies().concat([company]));
    return company;
}

/** Activate or deactivate a company. Its data is kept either way. */
export function setCompanyStatus(id: string, status: CompanyStatus): void {
    const list = companies(), c = list.find(x => x.id === id);
    if (!c || (c.status || 'active') === status) return;
    const at = new Date().toISOString();
    write(REGISTRY, list.map(x => x.id === id ? { ...x, status, statusChangedAt: at } : x));
    const what = status === 'active' ? 'activated' : 'deactivated';
    const entry = platformAudit(`company.${status === 'active' ? 'activate' : 'deactivate'}`, `Company ${c.name} (${c.code}) ${what}`);
    write(dataKey(id, 'audit'), read<AuditEntry[]>(dataKey(id, 'audit'), []).concat([{ ...entry, detail: `Company ${what} by the platform owner` }]));
    notify();
}

/* ---- Platform owner session ---- */
export interface PlatformSession { email: string; name: string; signedInAt: string }
export function getPlatformSession(): PlatformSession | null {
    try { const raw = sessionStorage.getItem(PLATFORM_SESSION) || localStorage.getItem(PLATFORM_SESSION); return raw ? JSON.parse(raw) as PlatformSession : null; } catch { return null; }
}
export function platformSignIn(remember: boolean): void {
    const s: PlatformSession = { email: PLATFORM_OWNER.email, name: PLATFORM_OWNER.name, signedInAt: new Date().toISOString() };
    try { (remember ? localStorage : sessionStorage).setItem(PLATFORM_SESSION, JSON.stringify(s)); } catch { /* storage unavailable */ }
    platformAudit('platform.signin', 'Platform owner signed in');
}
export function platformSignOut(): void {
    platformAudit('platform.signout', 'Platform owner signed out');
    try { sessionStorage.removeItem(PLATFORM_SESSION); localStorage.removeItem(PLATFORM_SESSION); } catch { /* storage unavailable */ }
}
