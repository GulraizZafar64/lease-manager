/* Bank statements and payment batches on the server (VITE_USE_API=true). The Bank reconciliation and
   Payment batches screens keep changing a statement or batch and saving it, as in the original page;
   here that change is sent as the server action it stands for (import, ignore, unmatch, submit, approve,
   reject, release). Matching a bank line goes straight to the server, which records the payment. */
import { api } from './client';
import { orNone, same, type ServerAdapter } from './adapter';
import type { BankStatement, PaymentBatch } from '../types/enterprise';

const enc = encodeURIComponent;

export const statementsOnServer: ServerAdapter<BankStatement> = {
    load: () => orNone(api.get<BankStatement[]>('/bank/statements')),
    async save(before, after) {
        if (!before) {
            before = await api.post<BankStatement>('/bank/statements', { id: after.id, name: after.name, format: after.format, account: after.account, lines: after.lines.map(l => ({ id: l.id, date: l.date, amount: l.amount, ref: l.ref, desc: l.desc })) });
        }
        const was = new Map(before.lines.map(l => [l.id, l]));
        // Matches are made through matchLines; here a match undone, and suggestions or lines marked as not lease-related
        for (const l of after.lines) { const o = was.get(l.id); if (o && o.status === 'matched' && l.status !== 'matched') await api.post(`/bank/lines/${enc(l.id)}/unmatch`); }
        const changed = after.lines.filter(l => { const o = was.get(l.id); return o && l.status !== 'matched' && !l.duplicate && (o.status !== l.status || !same(o.suggest, l.status === 'suggested' ? l.suggest : undefined)); });
        if (changed.length) await api.patch(`/bank/statements/${enc(after.id)}/lines`, { lines: changed.map(l => ({ id: l.id, status: l.status, ...(l.status === 'suggested' && l.suggest ? { suggest: l.suggest } : {}) })) });
    },
    remove: async id => { await api.del(`/bank/statements/${enc(id)}`); },
};

export interface MatchRequest { lineId: string; leaseId: string; dueDate: string; forType: string; auto: boolean }
export interface MatchResult { lineId: string; ok: boolean; match?: { leaseId: string; dueDate: string; key: string; by: string; auto: boolean }; error?: string; message?: string }
/** Each match is recorded or refused on its own. */
export const matchLines = async (matches: MatchRequest[]): Promise<MatchResult[]> => (await api.post<{ results: MatchResult[] }>('/bank/match', { matches })).results;

/** A batch as the server sends it: with the preparer's name, for people who cannot read the user list. */
export type ServerBatch = PaymentBatch & { createdByName?: string };
export const batchesOnServer: ServerAdapter<ServerBatch> = {
    load: () => orNone(api.get<ServerBatch[]>('/batches')),
    async save(before, after) {
        const id = enc(after.id);
        if (!before) {
            await api.post('/batches', { id: after.id, name: after.name, currency: after.currency, valueDate: after.valueDate, account: after.account, lines: after.lines });
            before = { ...after, status: 'draft', approvals: [] };
        }
        if (before.status === 'draft' && after.status === 'pending') await api.post(`/batches/${id}/submit`);
        else if (before.status === 'pending' && (after.approvals || []).length > (before.approvals || []).length) await api.post(`/batches/${id}/approve`);
        else if (before.status === 'pending' && after.status === 'rejected') await api.post(`/batches/${id}/reject`, {});
        else if (after.status === 'released' && (before.status === 'approved' || after.releasedAt !== before.releasedAt)) await api.post(`/batches/${id}/release`, {});
    },
    remove: async id => { await api.del(`/batches/${enc(id)}`); },
};
