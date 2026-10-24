/* Leases on the server (VITE_USE_API=true). Screens keep changing a copy of the lease and calling
   Store.save(), as in the original page; here that change is sent as the server action it stands for:
   create, edit, submit, approve, reject, change details, submit or decide a remeasurement, record a payment.
   The server checks each one (approval tiers, segregation, period lock) and the lease is then read back,
   so what is shown is always what the server holds. */
import { api } from './client';
import { SETTINGS } from '../domain/settings';
import { blankTerms } from '../domain/lease';
import type { Lease, LeaseEvent, LeasePayment } from '../types/lease';

/** A change the server does not take yet; the message says what to do instead. */
export class NotOnServerYet extends Error { }

const DATA_FIELDS = ['name', 'counterparty', 'contractNumber', 'currency', 'assetClass', 'location', 'area', 'areaUnit', 'costCentre', 'notes', 'terms', 'documents', 'bank', 'parentId', 'createdAt'] as const;
/** Fields that describe a lease without changing its measurement (editable after activation). */
const DETAIL_FIELDS = ['name', 'counterparty', 'contractNumber', 'assetClass', 'location', 'area', 'areaUnit', 'costCentre', 'notes', 'documents', 'bank', 'parentId'] as const;
const EVENT_META = new Set(['id', 'type', 'effective', 'status', 'reason', 'submittedBy', 'submittedByName', 'submittedOn', 'approvedBy', 'approvedByName', 'approvedOn', 'rejectedBy', 'rejectedByName', 'approvals']);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const enc = encodeURIComponent;

const entityName = (id?: string) => (SETTINGS.entities || []).find(e => e.id === id)?.name || '';
function entityId(l: Lease): string {
    const e = (SETTINGS.entities || []).find(x => x.name === l.entity);
    if (e && e.id) return e.id;
    throw new NotOnServerYet(`The entity “${l.entity}” is not saved on the server. Save it in Administration › Entities first.`);
}

/** The lease as the server sends it, in the shape the app uses (a draft saved elsewhere may lack some terms). */
const toLease = (d: Lease): Lease => ({ ...d, entity: entityName(d.entityId), terms: { ...blankTerms(), ...d.terms }, events: d.events || [], payments: d.payments || [], history: d.history || [], documents: d.documents || [] });

/** What the server stores for a lease (its own record of status, changes, payments and history aside). */
function body(l: Lease, checking = false): Record<string, unknown> {
    // When only checking, an entity not on the server yet (it is added before the leases) is left out
    const out: Record<string, unknown> = { id: l.id, entityId: checking ? (SETTINGS.entities || []).find(e => e.name === l.entity)?.id : entityId(l), role: l.role };
    for (const k of DATA_FIELDS) if (l[k] !== undefined) out[k] = l[k];
    return out;
}
const eventBody = (e: LeaseEvent) => ({
    type: e.type, effective: e.effective, reason: e.reason || '',
    params: Object.fromEntries(Object.entries(e).filter(([k, v]) => !EVENT_META.has(k) && (v === null || ['number', 'string', 'boolean'].includes(typeof v)))),
});
const paymentBody = (p: LeasePayment) => ({ kind: p.kind, dueDate: p.dueDate || undefined, forType: p.forType, amount: p.amount, paidDate: p.paidDate, ref: p.ref || undefined });

export const loadLeases = async (): Promise<Lease[]> => (await api.get<Lease[]>('/leases?full=1')).map(toLease);
export const loadLease = async (id: string): Promise<Lease> => toLease(await api.get<Lease>(`/leases/${enc(id)}?full=1`));
export const deleteLease = (id: string): Promise<unknown> => api.del(`/leases/${enc(id)}`);
/** Leases brought in as they are (sample portfolio, files with changes and payments): needs the data permission. */
const asImported = (l: Lease, checking = false) => ({ ...body(l, checking), status: l.status, events: l.events || [], payments: l.payments || [], history: l.history || [] });
export const importLeases = (list: Lease[], source: string, replace = false): Promise<{ imported: string[]; skipped: string[] }> =>
    api.post('/leases/import', { leases: list.map(l => asImported(l)), source, replace });
export interface ImportCheck { ok: string[]; existing: string[]; problems: { id: string; code: string; message: string }[] }
/** What bringing these leases in would do, lease by lease; nothing changes. A lease whose entity is not on the server yet is checked without it. */
export const checkLeaseImport = (list: Lease[], source: string): Promise<ImportCheck> =>
    api.post('/leases/import', { leases: list.map(l => asImported(l, true)), source, check: true });

/** Send the change from `before` (what the server holds) to `after`. */
export async function saveLease(before: Lease | undefined, after: Lease): Promise<void> {
    const id = enc(after.id);
    // Payments: new ones are recorded; bank lines are matched through Bank reconciliation (api/banking.ts), and the
    // original page has no way to change a recorded payment. Checked first, so nothing is sent when part of the change cannot be.
    const oldPays = new Map(((before && before.payments) || []).map(p => [p.id, p]));
    const added = (after.payments || []).filter(p => !oldPays.has(p.id));
    const changedPays = (after.payments || []).some(p => oldPays.has(p.id) && !same(oldPays.get(p.id), p)) || [...oldPays.keys()].some(k => !(after.payments || []).some(p => p.id === k));
    if (before && (changedPays || added.some(p => p.bankLineId))) throw new NotOnServerYet('Recorded payments cannot be changed here. Match bank lines from Bank reconciliation; record new payments from the lease or the Payments screen.');
    const was = before ? body(before) : {}, now = body(after);
    if (before && !['draft', 'pending', 'rejected'].includes(before.status) && ['entityId', 'role', 'currency', 'terms'].some(k => !same(was[k], now[k])))
        throw new NotOnServerYet('An active lease’s terms change only through a remeasurement or modification.');

    if (!before) {
        if ((after.events && after.events.length) || (after.payments && after.payments.length)) { await importLeases([after], 'file import'); return; }
        await api.post('/leases', body(after));
        if (after.status !== 'draft') await api.post(`/leases/${id}/submit`);
        return;
    }
    // Approving or rejecting a new lease
    if (before.status === 'pending' && (after.approvals || []).length > (before.approvals || []).length) { await api.post(`/leases/${id}/approve`); return; }
    if (before.status === 'pending' && after.status === 'rejected') { await api.post(`/leases/${id}/reject`, {}); return; }

    if (['draft', 'pending', 'rejected'].includes(before.status)) {
        const edited = !same(was, now);
        if (edited) await api.put(`/leases/${id}`, { ...now, version: before.version });
        if (after.status !== 'draft' && (edited || before.status !== 'pending')) await api.post(`/leases/${id}/submit`);
    } else {
        // After activation the measurement changes only through a remeasurement or modification (IFRS 16.39-46)
        const details = DETAIL_FIELDS.filter(k => !same(was[k], now[k]));
        if (details.length) await api.patch(`/leases/${id}/details`, Object.fromEntries(details.map(k => [k, now[k] ?? null])));
    }

    // Remeasurements and modifications: new ones submitted, pending ones approved or rejected
    const oldEvents = new Map((before.events || []).map(e => [e.id, e]));
    for (const e of after.events || []) {
        const o = oldEvents.get(e.id);
        if (!o) await api.post(`/leases/${id}/events`, eventBody(e));
        else if (o.status === 'pending' && (e.approvals || []).length > (o.approvals || []).length) await api.post(`/events/${enc(e.id)}/approve`);
        else if (o.status === 'pending' && e.status === 'rejected') await api.post(`/events/${enc(e.id)}/reject`, {});
    }

    for (const p of added) await api.post(`/leases/${id}/payments`, paymentBody(p));
}
