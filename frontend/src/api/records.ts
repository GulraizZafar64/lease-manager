/* ERP export files, AI-drafted disclosures and the audit log on the server (VITE_USE_API=true).
   The ERP export and Narrative drafts screens keep changing a record and saving it, as in the original
   page; here that change is sent as the server action it stands for. The Administration audit view reads
   the server's log, and the few actions only the browser sees (report exports, AI requests, screen locks…)
   are added to it. */
import { api } from './client';
import { orNone, type ServerAdapter } from './adapter';
import { SETTINGS } from '../domain/settings';
import { fmtNum } from '../utils/format';
import type { AuditEntry, DraftRecord, ExportRecord } from '../types/enterprise';

const enc = encodeURIComponent;

export const exportsOnServer: ServerAdapter<ExportRecord> = {
    load: () => orNone(api.get<ExportRecord[]>('/erp-exports')),
    async save(before, after) {
        if (!before) {
            await api.post('/erp-exports', { id: after.id, target: after.target, from: after.from, to: after.to, count: after.count, debits: after.debits, keys: after.keys });
            before = { ...after, status: 'generated' };
        }
        if (before.status === 'generated' && after.status !== 'generated') await api.post(`/erp-exports/${enc(after.id)}/mark`, { status: after.status, notes: after.notes || '' });
    },
    remove: () => Promise.reject(new Error('ERP files are kept as a record.')),
};

/** A draft as the server sends it: with the preparer's name, for people who cannot read the user list. */
export type ServerDraft = DraftRecord & { createdByName?: string };
export const draftsOnServer: ServerAdapter<ServerDraft> = {
    load: () => api.get<ServerDraft[]>('/ai-drafts'),
    async save(before, after) {
        const id = enc(after.id);
        if (!before) {
            await api.post('/ai-drafts', { id: after.id, title: after.title, from: after.from, to: after.to, text: after.text, source: after.source });
            before = { ...after, approvals: [] };
        }
        if (after.text !== before.text) { await api.put(`/ai-drafts/${id}`, { text: after.text }); return; } // its approvals are needed again
        if ((after.approvals || []).length > (before.approvals || []).length) await api.post(`/ai-drafts/${id}/approve`);
    },
    remove: async id => { await api.del(`/ai-drafts/${enc(id)}`); },
};

/* ---- Audit log ---- */
/** Actions only the browser sees; the server records everything else itself. */
export const CLIENT_ACTIONS = new Set(['export', 'ai', 'session.lock', 'session.switch', 'role.preview', 'access.request']);
export const recordClientAction = (action: string, detail: string, leaseId?: string): Promise<unknown> =>
    api.post('/audit/client', { action, detail: detail.slice(0, 600), ...(leaseId ? { leaseId } : {}) });

interface ServerAuditRow { id: number; at: string; user_id: string | null; user_name: string | null; role: string | null; action: string; object_type: string | null; object_id: string | null; entity_id: string | null; detail: Record<string, unknown> }
const words = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const show = (v: unknown): string => typeof v === 'number' ? fmtNum(v) : String(v);
/** The server's detail, as one line: its values, the fields a change touched, nested counts. */
function describe(d: Record<string, unknown>): string {
    if (typeof d.text === 'string') return d.text;
    const parts: string[] = [];
    if (d.after && typeof d.after === 'object') parts.push('changed: ' + Object.keys(d.after).map(words).join(', '));
    for (const [k, v] of Object.entries(d)) {
        if (v === null || v === undefined || v === '' || v === false || k === 'before' || k === 'after' || k === 'lastVersion') continue;
        if (Array.isArray(v)) { if (v.length) parts.push(`${words(k)}: ${v.length > 6 || v.some(x => typeof x === 'object') ? v.length : v.join(', ')}`); }
        else if (typeof v === 'object') { // one level down: values, and lists as their length
            const flat = Object.entries(v as Record<string, unknown>).map(([a, x]) => [a, Array.isArray(x) ? x.length : x] as const).filter(([, x]) => ['string', 'number'].includes(typeof x));
            if (flat.length) parts.push(`${words(k)}: ${flat.map(([a, x]) => `${words(a)} ${show(x)}`).join(', ')}`);
        }
        else parts.push(v === true ? words(k) : `${words(k)}: ${show(v)}`);
    }
    return parts.join('; ').slice(0, 600);
}
/** The company's audit log, newest first, in the shape the audit view uses; with the browser app's log, if it was brought over. */
export async function loadServerAudit(limit: number): Promise<AuditEntry[]> {
    const n = Math.min(5000, limit);
    const [rows, archive] = await Promise.all([api.get<ServerAuditRow[]>(`/audit?limit=${n}`), api.get<AuditEntry[]>(`/audit/archive?limit=${n}`)]);
    const entity = (id: string | null) => (id && (SETTINGS.entities || []).find(e => e.id === id)?.name) || '';
    const kept = archive.map(a => ({ ...a, detail: `${a.detail} (browser app)`, leaseId: a.leaseId || undefined, entity: a.entity || undefined }));
    return rows.map(r => ({
        id: String(r.id), at: r.at, actor: r.user_id || '', actorName: r.user_name || 'System', role: r.role || '', action: r.action, detail: describe(r.detail || {}),
        leaseId: r.object_type === 'lease' ? r.object_id || undefined : typeof r.detail?.leaseId === 'string' ? r.detail.leaseId : undefined, entity: entity(r.entity_id) || undefined,
    }) as AuditEntry).concat(kept).sort((x, y) => y.at.localeCompare(x.at)).slice(0, n);
}
/** Delete entries dated before `before`; the server allows it only past the company's saved retention period. */
export const purgeServerAudit = async (before: string): Promise<number> => (await api.post<{ deleted: number }>('/audit/purge', { before })).deleted;

/* ---- The company's data ---- */
export const companyExport = (): Promise<Record<string, unknown>> => api.get('/company-export');
export interface RestoreResult { restored: Record<'bank' | 'batches' | 'exports' | 'drafts', number>; skipped: Record<string, string[]> }
export const restoreRecords = (body: { source: string; bank?: unknown[]; batches?: unknown[]; exports?: unknown[]; drafts?: unknown[] }): Promise<RestoreResult> => api.post('/company-restore', body);
