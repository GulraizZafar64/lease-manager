/* Lease model helpers and the per-lease engine results cache. */
import { addDays, addMonths, leaseTerm, num, run } from './engine';
import { ASSET_CLASSES, SETTINGS, engineSettings } from './settings';
import { Store } from './store';
import { AS_OF } from './state';
import type { EngineResult } from '../types/engine';
import type { DisplayStatus, Lease, LeaseRole, LeaseTerms } from '../types/lease';
import { todayISO } from '../utils/dates';

export function blankTerms(): LeaseTerms {
    return {
        commencement: '', termMonths: 60, payment: '', freqM: 1, timing: 'advance', rentFreeMonths: 0,
        escalation: { type: 'none', rate: '', everyM: 12, indexBase: '' },
        extension: { months: '', payment: '', certain: false }, termination: { month: '', penalty: '', certain: false, notice: '' },
        purchase: { price: '', certain: false }, rvg: '',
        discountRate: '', rateBasis: 'IBR', fairValue: '', lessorIDC: '', urv: '',
        idc: '', incentives: '', prepaid: '', restoration: '', deposit: '',
        usefulLifeM: '', ownershipTransfer: false, exemption: 'none',
        serviceComponent: '', combine: true, variableNote: '',
        carryingAmount: '', dealer: false, classification: 'auto', marketRate: '', specialised: false, underlyingRemainingLifeM: '',
        gracePeriodDays: 5, lateType: 'interest', lateRate: 2, fineRate: 1, partialRule: 'interest-first',
    };
}
export function blankLease(): Lease {
    return {
        id: '', contractNumber: '', name: '', role: 'lessee', counterparty: '', assetClass: 'building', location: '', area: '', areaUnit: 'sq ft',
        currency: SETTINGS.functionalCurrency || 'PKR', entity: SETTINGS.entity, costCentre: '', status: 'draft', notes: '',
        terms: blankTerms(), events: [], payments: [], history: [], documents: [], createdAt: todayISO(),
    };
}

/* Results cache: engine output per lease, invalidated on change */
const RESULT = new Map<string, { k: string; res: EngineResult | null }>();
export const clearResults = (): void => RESULT.clear();
export const dropResult = (id: string): void => { RESULT.delete(id); };
function leaseKey(l: Lease): string { return JSON.stringify([l.role, l.terms, l.events, SETTINGS.rateConvention, SETTINGS.majorPartPct, SETTINGS.substantiallyAllPct]); }
export function getResult(l: Lease | null | undefined): EngineResult | null {
    if (!l || !l.terms || !l.terms.commencement || !num(l.terms.termMonths)) return null;
    const k = leaseKey(l), hit = RESULT.get(l.id);
    if (hit && hit.k === k) return hit.res;
    let res: EngineResult | null;
    try { res = run(l, engineSettings()); } catch (e) { console.error(e); res = null; }
    RESULT.set(l.id, { k, res });
    return res;
}

export function leaseEnd(l: Lease): string {
    const T = l.terms;
    if (!T.commencement) return '';
    const res = getResult(l);
    const m = res ? res.termMonths : leaseTerm(T);
    return addDays(addMonths(T.commencement, m), -1);
}
export function contractEnd(l: Lease): string { return l.terms.commencement ? addDays(addMonths(l.terms.commencement, num(l.terms.termMonths)), -1) : ''; }

export function statusOf(l: Lease, asOf: string): DisplayStatus {
    if (l.status === 'draft' || l.status === 'pending' || l.status === 'rejected') return l.status;
    const res = getResult(l);
    if (res && res.mode === 'lessee' && res.endReason === 'terminated') {
        const ev = res.events.find(e => e.type === 'terminate');
        if (ev && ev.date <= asOf) return 'terminated';
    }
    const end = leaseEnd(l);
    if (end && end < asOf) return 'expired';
    if (l.terms.commencement > asOf) return 'future';
    return 'active';
}
export const STATUS_LABEL: Record<string, string> = { draft: 'Draft', pending: 'Pending approval', rejected: 'Rejected', active: 'Active', future: 'Not yet commenced', expired: 'Expired', terminated: 'Terminated' };
export const STATUS_CLASS: Record<string, string> = { draft: 'neutral', pending: 'pending', rejected: 'bad', active: 'ok', future: 'info', expired: 'neutral', terminated: 'neutral' };
export const isLive = (l: Lease): boolean => !['draft', 'pending', 'rejected'].includes(l.status);
export function measurementType(l: Lease): string {
    if (l.role === 'lessor') { const r = getResult(l); return r ? (r.mode === 'lessor-finance' ? 'Finance lease (lessor)' : 'Operating lease (lessor)') : 'Lessor'; }
    if (l.terms.exemption === 'short-term') return 'Short-term exemption';
    if (l.terms.exemption === 'low-value') return 'Low-value exemption';
    return 'Right-of-use model';
}
export const assetClassLabel = (k: string): string => ASSET_CLASSES[k] || k;

/** The next free lease ID for the year of the as-of date (LS-2025-001, LR-2025-001). */
export function nextLeaseId(role: LeaseRole | string): string {
    const p = role === 'lessor' ? 'LR' : 'LS', y = AS_OF.slice(0, 4);
    let n = 1; while (Store.get(`${p}-${y}-${String(n).padStart(3, '0')}`)) n++;
    return `${p}-${y}-${String(n).padStart(3, '0')}`;
}
