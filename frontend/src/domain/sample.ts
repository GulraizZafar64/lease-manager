/* Sample portfolio (illustrative; dates are relative to today) */
import { addMonths, monthsBetween, run } from './engine';
import { engineSettings } from './settings';
import { blankLease, blankTerms, isLive } from './lease';
import { Store } from './store';
import { guard } from './enterprise';
import { go } from './nav';
import { toast } from '../utils/uiStore';
import { uid } from '../utils/format';
import { todayISO } from '../utils/dates';
import type { Lease, LeaseTerms } from '../types/lease';

export function sampleLeases(): Lease[] {
    const t0 = todayISO();
    const first = (m: number) => addMonths(t0.slice(0, 8) + '01', m);
    const L = (o: Partial<Lease>, t: Partial<LeaseTerms>): Lease => {
        const l = blankLease(); Object.assign(l, o); l.terms = Object.assign(blankTerms(), t); l.status = o.status || 'active';
        l.history = [{ at: new Date().toISOString(), actor: 'sample', actorName: 'Sample data', text: 'Loaded as sample data' }];
        return l;
    };
    const fixed = (rate: number, everyM: number) => ({ type: 'fixed' as const, rate, everyM });
    const list = [
        L({ id: 'HO-LHR-01', name: 'Head office, 3rd and 4th floors', counterparty: 'Canal View Properties (Pvt) Ltd', assetClass: 'building', location: 'Lahore', area: 12500, contractNumber: 'CVP/2024/117' },
            { commencement: first(-27), termMonths: 60, payment: 1850000, freqM: 1, timing: 'advance', escalation: fixed(10, 12), extension: { months: 60, payment: '', certain: false }, discountRate: 16, idc: 450000, deposit: 5550000, usefulLifeM: 0 }),
        L({ id: 'WH-KHI-01', name: 'Distribution warehouse, Port Qasim', counterparty: 'Indus Logistics Parks', assetClass: 'warehouse', location: 'Karachi', area: 45000, contractNumber: 'ILP-WH-0412' },
            { commencement: first(-20), termMonths: 36, payment: 2400000, freqM: 1, timing: 'advance', escalation: fixed(10, 12), discountRate: 15.5, idc: 300000, restoration: 1200000 }),
        L({ id: 'DP-FSD-01', name: 'Regional depot', counterparty: 'Lyallpur Estates', assetClass: 'warehouse', location: 'Faisalabad', area: 18000, contractNumber: 'LE-77/22' },
            { commencement: first(-30), termMonths: 60, payment: 4500000, freqM: 3, timing: 'advance', discountRate: 15 }),
        L({ id: 'DP-RWP-01', name: 'City depot', counterparty: 'Pothohar Holdings', assetClass: 'warehouse', location: 'Rawalpindi', area: 9500, contractNumber: 'PH-DEP-09' },
            { commencement: first(-32), termMonths: 36, payment: 9600000, freqM: 12, timing: 'advance', discountRate: 14, extension: { months: 24, payment: 10800000, certain: false } }),
        L({ id: 'DP-MUL-ST', name: 'Seasonal godown', counterparty: 'Multan Cold Chain', assetClass: 'warehouse', location: 'Multan', area: 6000, contractNumber: 'MCC-SEAS-26' },
            { commencement: first(-4), termMonths: 11, payment: 650000, freqM: 1, timing: 'advance', exemption: 'short-term', discountRate: 15 }),
        L({ id: 'VH-FLT-01', name: 'Delivery fleet, 20 light commercial vehicles', counterparty: 'Crescent Leasing Modaraba', assetClass: 'vehicle', location: 'Punjab', contractNumber: 'CLM-VL-2291' },
            { commencement: first(-14), termMonths: 48, payment: 1250000, freqM: 1, timing: 'arrears', discountRate: 17, purchase: { price: 2000000, certain: true }, usefulLifeM: 96, idc: 150000 }),
        L({ id: 'EQ-FLK-01', name: 'Forklift trucks (6)', counterparty: 'MechLift Rentals', assetClass: 'equipment', location: 'Karachi', contractNumber: 'MLR-0099' },
            { commencement: first(-9), termMonths: 60, payment: 360000, freqM: 1, timing: 'arrears', discountRate: 16.5, rvg: 500000, usefulLifeM: 120 }),
        L({ id: 'EQ-GEN-01', name: 'Standby generator, 500 kVA', counterparty: 'PowerGen Rentals', assetClass: 'equipment', location: 'Karachi', contractNumber: 'PGR-500-14' },
            { commencement: first(-6), termMonths: 36, payment: 280000, freqM: 1, timing: 'advance', discountRate: 16, serviceComponent: 40000, combine: false }),
        L({ id: 'IT-PRN-LV', name: 'Office printers and copiers', counterparty: 'Office Tech Solutions', assetClass: 'it', location: 'Lahore', contractNumber: 'OTS-PRN-31' },
            { commencement: first(-10), termMonths: 36, payment: 45000, freqM: 1, timing: 'advance', exemption: 'low-value', discountRate: 16 }),
        L({ id: 'OF-ISB-01', name: 'Liaison office', counterparty: 'Blue Area Towers', assetClass: 'building', location: 'Islamabad', area: 2200, contractNumber: 'BAT-1907' },
            { commencement: first(-40), termMonths: 60, payment: 420000, freqM: 1, timing: 'advance', escalation: fixed(10, 12), discountRate: 13 }),
        L({ id: 'SL-HO-01', name: 'Sublet: part of 4th floor, head office', role: 'lessor', counterparty: 'Northline Consulting', assetClass: 'building', location: 'Lahore', area: 2500, contractNumber: 'SUB-HO-01' },
            { commencement: first(-12), termMonths: 36, payment: 320000, freqM: 1, timing: 'advance', classification: 'operating', carryingAmount: 0, discountRate: 16 }),
        L({ id: 'FL-VC-01', name: 'Visi-coolers placed with retailers (hire purchase)', role: 'lessor', counterparty: 'Retail partners, Lahore North', assetClass: 'equipment', location: 'Lahore', contractNumber: 'HP-VC-LHN' },
            { commencement: first(-8), termMonths: 36, payment: 330000, freqM: 1, timing: 'arrears', fairValue: 9000000, carryingAmount: 7500000, lessorIDC: 120000, dealer: true, ownershipTransfer: true, classification: 'auto', usefulLifeM: 84, discountRate: 0 }),
    ];
    const find = (id: string) => list.find(l => l.id === id) as Lease;
    // Events
    find('WH-KHI-01').events.push({ id: uid('ev'), type: 'mod-change', effective: first(-6), status: 'approved', newPayment: 2200000, newRate: 17, reason: 'Rent reduced after renegotiation; covenant to stay 12 months longer', newEndMonth: 48, submittedBy: 'sample', submittedByName: 'Sample data', submittedOn: first(-6), approvedBy: 'sample', approvedByName: 'Sample data' });
    find('DP-FSD-01').events.push({ id: uid('ev'), type: 'mod-decrease', effective: first(1), status: 'pending', areaRetainedPct: 70, newPayment: 3300000, newRate: 17.5, reason: 'Hand back 30% of the depot floor to the landlord', submittedBy: 'sample', submittedByName: 'Sample data', submittedOn: t0 });
    find('OF-ISB-01').events.push({ id: uid('ev'), type: 'terminate', effective: first(-4), status: 'approved', penalty: 840000, reason: 'Office consolidated into Rawalpindi depot', submittedBy: 'sample', submittedByName: 'Sample data', submittedOn: first(-5) });
    const gen = find('EQ-GEN-01');
    gen.status = 'pending'; gen.history.push({ at: new Date().toISOString(), actor: 'sample', actorName: 'Sample data', text: 'Submitted for approval' });
    // Payments: everything due before today paid, except one overdue and one partial
    for (const l of list) {
        if (!isLive(l)) continue;
        const res = run(l, engineSettings());
        res.cashflows.filter(f => f.date < t0).forEach(f => l.payments.push({ id: uid('p'), dueDate: f.date, amount: Math.round(f.amount), paidDate: f.date, kind: 'scheduled', ref: 'Bank transfer' }));
    }
    const ho = find('HO-LHR-01');
    const lastHo = ho.payments.pop(); // most recent instalment left unpaid
    if (lastHo && monthsBetween(lastHo.dueDate, t0) < 1) { /* keep as overdue */ } else if (lastHo) ho.payments.push(lastHo);
    const flk = find('EQ-FLK-01');
    const lastF = flk.payments[flk.payments.length - 1];
    if (lastF) lastF.amount = Math.round(lastF.amount / 2);
    return list;
}

export async function loadSample(): Promise<void> {
    if (!guard('admin.data', 'load sample data')) return;
    const list = sampleLeases();
    const n = await Store.importAll(list, 'Sample portfolio');
    if (!n) return;
    toast(`${n} sample leases loaded`);
    go('dashboard', {}, { reset: true });
}
