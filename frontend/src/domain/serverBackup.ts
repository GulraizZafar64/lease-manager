/* Backups and restore signed in through the API (VITE_USE_API=true). A backup is the server's export of
   the whole company. Restoring reads either that export or a backup downloaded from the browser-only
   app, and brings it back through the server's own checks: settings (entities and dated rates are
   added, never removed), leases with their changes, payments and history (same IDs replaced), then bank
   statements, payment batches, ERP files and drafts (added when new; approvals are given again). */
import { SETTINGS, type AppSettings, type EntityRecord, type FxHistoryEntry } from './settings';
import { Store } from './store';
import { Ent } from './enterprise';
import { importLeases } from '../api/leases';
import { companyExport, restoreRecords } from '../api/records';
import { deepClone } from '../utils/format';
import type { Lease } from '../types/lease';

interface ExportedEntity { id: string; code: string; name: string; functional_currency: string; parent_id: string | null; country: string | null }
export interface BackupData {
    settings?: Partial<AppSettings>; leases?: Lease[]; bank?: unknown[]; batches?: unknown[]; exports?: unknown[]; drafts?: unknown[];
    /** In the server's export only: entities and dated rates are kept outside the settings there. */
    entities?: ExportedEntity[]; fxRates?: { date: string; currency: string; rate: number }[];
}

/** The whole company, as the server exports it (needs the data permission). */
export const companyBackupText = async (): Promise<string> => JSON.stringify(await companyExport());

/** Pieces of at most about 1.5 MB, so each request stays within the server's size limit. */
export function chunks<T>(list: T[], max = 1_500_000): T[][] {
    const out: T[][] = []; let cur: T[] = [], size = 0;
    for (const x of list) { const n = JSON.stringify(x).length; if (cur.length && size + n > max) { out.push(cur); cur = []; size = 0; } cur.push(x); size += n; }
    if (cur.length) out.push(cur);
    return out;
}
const PERSONAL: (keyof AppSettings)[] = ['theme', 'userName', 'lastBackup', 'lastBackupBy', 'entities', 'fxHistory'];

/** The backup's settings saved for the company, with its entities and dated rates added to the company's (none removed). */
export async function mergeSettings(d: BackupData): Promise<boolean> {
    const fromExport: EntityRecord[] = (d.entities || []).map(e => ({ name: e.name, code: e.code, functionalCurrency: e.functional_currency, parent: (d.entities || []).find(p => p.id === e.parent_id)?.name || '', country: e.country || '' }));
    const theirs = fromExport.length ? fromExport : (d.settings && d.settings.entities) || [];
    const rates: FxHistoryEntry[] = d.fxRates ? Object.values(d.fxRates.reduce<Record<string, FxHistoryEntry>>((m, r) => { (m[r.date] = m[r.date] || { date: r.date, rates: {} }).rates[r.currency] = r.rate; return m; }, {})) : (d.settings && d.settings.fxHistory) || [];
    if (d.settings) Object.assign(SETTINGS, deepClone(Object.fromEntries(Object.entries(d.settings).filter(([k]) => !PERSONAL.includes(k as keyof AppSettings)))));
    const have = SETTINGS.entities || [], named = (n: string) => have.some(e => e.name.toLowerCase() === n.trim().toLowerCase());
    // Entities named only on leases are added too; a code another entity here already uses gets a free one
    const onLeases = [...new Set((d.leases || []).map(l => l.entity).filter((n): n is string => !!n))].filter(n => !theirs.some(e => e.name === n))
        .map(name => ({ name, code: '', functionalCurrency: SETTINGS.functionalCurrency, parent: '', country: '' }));
    const codes = new Set(have.map(e => e.code.toLowerCase()));
    const freeCode = (code: string) => { let c = code.trim(), n = 1; while (!c || codes.has(c.toLowerCase())) c = 'E' + String(n++).padStart(2, '0'); codes.add(c.toLowerCase()); return c; };
    SETTINGS.entities = have.concat(theirs.concat(onLeases).filter(e => e.name && !named(e.name)).map(e => ({ name: e.name, code: freeCode(e.code || ''), functionalCurrency: e.functionalCurrency || SETTINGS.functionalCurrency, parent: e.parent, country: e.country || '' })));
    SETTINGS.entities.forEach(e => { if (e.parent && !SETTINGS.entities?.some(p => p.name === e.parent)) e.parent = ''; });
    const hist = (SETTINGS.fxHistory || []).map(h => ({ date: h.date, rates: { ...h.rates } }));
    for (const r of rates) { const h = hist.find(x => x.date === r.date); if (h) h.rates = { ...r.rates, ...h.rates }; else hist.push({ date: r.date, rates: { ...r.rates } }); }
    SETTINGS.fxHistory = hist;
    return Store.saveSettings();
}

/** Restore a backup; returns what was done, for the person to read. Stops at the first refusal, with its reason. */
export async function restoreToServer(d: BackupData, source: string): Promise<string> {
    if (!await mergeSettings(d)) return 'Nothing restored: the settings were refused.';

    // Leases, with entities named as they are here (the server's export links them by id)
    const done: string[] = [], entityName = (id?: string) => (d.entities || []).find(e => e.id === id)?.name || '';
    const leases = (d.leases || []).map(l => ({ ...l, entity: l.entity || entityName(l.entityId) })).filter(l => l.id && l.entity);
    let n = 0;
    try {
        for (const part of chunks(leases)) n += (await importLeases(part, `restore: ${source}`, true)).imported.length;
        done.push(`${n} leases`);
        const counts = { bank: 0, batches: 0, exports: 0, drafts: 0 };
        for (const k of ['bank', 'batches', 'exports', 'drafts'] as const)
            for (const part of chunks(d[k] || [])) counts[k] += (await restoreRecords({ source, [k]: part })).restored[k];
        done.push(`${counts.bank} bank statements`, `${counts.batches} payment batches`, `${counts.exports} ERP files`, `${counts.drafts} drafts`);
    } catch (e) {
        await refreshAll();
        return `Restore stopped: ${e instanceof Error ? e.message : 'check your connection'}. Restored so far: settings${done.length ? ', ' + done.join(', ') : n ? `, ${n} leases` : ''}.`;
    }
    await refreshAll();
    return `Restored settings, ${done.join(', ')}. Records already on the server were kept; batches and drafts that were approved need approving again. People's accounts are managed on the Users screen and are not restored.`;
}
export async function refreshAll(): Promise<void> {
    await Promise.all([Store.refresh(), Ent.bank.refresh(), Ent.batches.refresh(), Ent.exports.refresh(), Ent.drafts.refresh()]);
}
