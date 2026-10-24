/* Where the platform console's companies come from: the backend API (VITE_USE_API=true)
   or this browser (interface preview). The console and the Add company form use either. */
import { api } from '../api/client';
import {
    companies, companyFieldProblems, companyLeaseCount, companyProblems, companyUsers, createCompany, isCompanyActive, setCompanyStatus, slug,
    type CompanyStatus, type NewCompany,
} from '../domain/platform';

export interface CompanyPerson { id: string; name: string; email: string }
export interface CompanyRow {
    id: string; name: string; code: string; currency: string; status: CompanyStatus; statusChangedAt?: string | null; createdAt: string;
    demo?: boolean; superAdmins: CompanyPerson[]; usersActive: number; usersTotal: number; leases: number;
}
/** A new super administrator; the API returns a temporary password, shown once. */
export interface NewAdmin { name: string; email: string; temporaryPassword?: string }
export interface CreatedCompany { company: CompanyRow; superAdmins: NewAdmin[] }

export interface PlatformSource {
    /** True when passwords and data are on the server. */
    server: boolean;
    list(): Promise<CompanyRow[]>;
    /** Field problems found before sending (the server checks again). */
    problems(c: NewCompany): Record<string, string>;
    create(c: NewCompany): Promise<CreatedCompany>;
    setStatus(id: string, status: CompanyStatus): Promise<CompanyRow>;
}

/* ---- This browser ---- */
function localRow(id: string): CompanyRow {
    const c = companies().find(x => x.id === id);
    if (!c) throw new Error('Company not found');
    const users = companyUsers(c.id).filter(u => u.email);
    return {
        id: c.id, name: c.name, code: c.code, currency: c.currency, status: isCompanyActive(c) ? 'active' : 'inactive',
        statusChangedAt: c.statusChangedAt || null, createdAt: c.createdAt, demo: c.demo,
        superAdmins: users.filter(u => u.role === 'superadmin' && u.status === 'active').map(u => ({ id: u.id, name: u.name || '', email: u.email || '' })),
        usersActive: users.filter(u => u.status === 'active').length, usersTotal: users.length, leases: companyLeaseCount(c.id),
    };
}
export const localSource: PlatformSource = {
    server: false,
    list: async () => companies().slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(c => localRow(c.id)),
    problems: companyProblems,
    create: async c => { const co = createCompany(c); return { company: localRow(co.id), superAdmins: c.admins.map(a => ({ name: a.name, email: a.email.toLowerCase() })) }; },
    setStatus: async (id, status) => { setCompanyStatus(id, status); return localRow(id); },
};

/* ---- Backend API (lease-manager/src/platform.js) ---- */
export const apiSource: PlatformSource = {
    server: true,
    list: () => api.get<CompanyRow[]>('/platform/companies'),
    problems: companyFieldProblems,
    create: c => api.post<CreatedCompany>('/platform/companies', { name: c.name.trim(), code: slug(c.code), currency: c.currency, admins: c.admins.map(a => ({ name: a.name.trim(), email: a.email.trim() })) }),
    setStatus: (id, status) => api.patch<CompanyRow>(`/platform/companies/${id}`, { status }),
};
