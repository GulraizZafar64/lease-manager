/* Company settings, entities and exchange rates on the server (VITE_USE_API=true).
   Screens keep editing SETTINGS and calling Store.saveSettings(), as in the original page; here that
   sends only what changed since the last load: settings fields, then entities, then dated rates.
   Per-person choices (theme, "your name") stay in this browser. */
import { ApiError, api } from './client';
import { serverMe, setServerEntities, type ServerEntity } from './auth';
import { SETTINGS, type AppSettings, type EntityRecord, type FxHistoryEntry } from '../domain/settings';
import { toast } from '../utils/uiStore';
import { deepClone } from '../utils/format';
import type { Permission } from '../types/enterprise';

/** Settings saved for the whole company (lease-manager/src/companySettings.js FIELDS). */
const COMPANY_FIELDS = [
    'entity', 'functionalCurrency', 'fyEndMonth', 'rateConvention', 'majorPartPct', 'substantiallyAllPct', 'lowValueThreshold', 'lowValueCurrency',
    'requireApproval', 'segregateApproval', 'interestCashFlow', 'numberGrouping', 'displayUnit', 'fx', 'accounts', 'presentationCurrency',
    'lockedThrough', 'defaultRate', 'approvalPolicy', 'bankAccounts', 'erp', 'retention', 'exitPenaltyMonths', 'lastBackup', 'lastBackupBy',
] as const satisfies readonly (keyof AppSettings)[];
type CompanyField = typeof COMPANY_FIELDS[number];
/** Fields other duties may save; the rest need admin.settings (as the server checks). */
const PERM_FOR: Partial<Record<CompanyField, Permission[]>> = { erp: ['gl.export'], retention: ['admin.data'], lastBackup: ['admin.data'], lastBackupBy: ['admin.data'] };

interface ServerRate { date: string; currency: string; rate: number }
interface Snapshot { fields: Partial<AppSettings>; entities: EntityRecord[]; rates: Map<string, number> }
let last: Snapshot | null = null;

const holds = (p: Permission) => !!serverMe()?.permissions.includes(p);
const mayChange = (f: CompanyField) => holds('admin.settings') || (PERM_FOR[f] || []).some(holds);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const rateKey = (date: string, ccy: string) => `${date}|${ccy}`;
const ratesOf = (hist: FxHistoryEntry[] = []) => new Map(hist.flatMap(h => Object.entries(h.rates).map(([c, r]) => [rateKey(h.date, c), Number(r)] as [string, number])));

function toRecords(rows: ServerEntity[]): EntityRecord[] {
    const name = (id: string | null) => rows.find(r => r.id === id)?.name || '';
    return rows.map(r => ({ id: r.id, name: r.name, code: r.code, functionalCurrency: r.functional_currency, parent: name(r.parent_id), country: r.country || '' }));
}
function toHistory(rows: ServerRate[]): FxHistoryEntry[] {
    const byDate = new Map<string, Record<string, number>>();
    for (const r of rows) byDate.set(r.date, { ...(byDate.get(r.date) || {}), [r.currency]: r.rate });
    return [...byDate].map(([date, rates]) => ({ date, rates }));
}

/** Read the company's settings, entities and dated rates into SETTINGS. */
export async function loadCompanySettings(): Promise<void> {
    const [fields, ents, rates] = await Promise.all([
        api.get<Partial<AppSettings>>('/company-settings'), api.get<ServerEntity[]>('/entities'), api.get<ServerRate[]>('/fx-rates'),
    ]);
    Object.assign(SETTINGS, deepClone(fields));
    setServerEntities(ents);
    SETTINGS.entities = toRecords(ents);
    SETTINGS.fxHistory = toHistory(rates);
    // New leases start in the default entity: one the server has
    if (SETTINGS.entities.length && !SETTINGS.entities.some(e => e.name === SETTINGS.entity)) SETTINGS.entity = SETTINGS.entities[0].name;
    last = { fields: deepClone(Object.fromEntries(COMPANY_FIELDS.map(f => [f, SETTINGS[f]]))), entities: deepClone(SETTINGS.entities), rates: ratesOf(SETTINGS.fxHistory) };
}

/** Entities: new ones added, changed ones updated (parents once all exist), removed ones deleted. */
async function saveEntities(before: EntityRecord[], now: EntityRecord[]): Promise<void> {
    const ids = new Map(before.filter(e => e.id).map(e => [e.name, e.id as string]));
    // An entity without an id but with the name of one on the server (a restored backup) is that entity
    for (const e of now.filter(x => !x.id)) {
        const match = before.find(b => b.id && b.name.toLowerCase() === e.name.trim().toLowerCase() && !now.some(x => x.id === b.id));
        if (match) e.id = match.id;
    }
    for (const e of now.filter(x => !x.id)) {
        const row = await api.post<ServerEntity>('/entities', { code: e.code.trim(), name: e.name.trim(), functionalCurrency: e.functionalCurrency, country: e.country || null });
        e.id = row.id; ids.set(row.name, row.id);
    }
    now.forEach(e => { if (e.id) ids.set(e.name, e.id); });
    for (const e of now) {
        const was = before.find(b => b.id === e.id);
        const parentId = e.parent ? ids.get(e.parent) ?? null : null;
        const wasParent = was && was.parent ? ids.get(was.parent) ?? null : null;
        const patch: Record<string, unknown> = {};
        if (!was || was.name !== e.name) patch.name = e.name.trim();
        if (!was || was.code !== e.code) patch.code = e.code.trim();
        if (!was || was.functionalCurrency !== e.functionalCurrency) patch.functionalCurrency = e.functionalCurrency;
        if (!was || (was.country || '') !== (e.country || '')) patch.country = e.country || null;
        if (!was ? !!parentId : parentId !== wasParent) patch.parentId = parentId;
        // New entities were created with these values already; only their parent may be left to set
        const send = was ? patch : (patch.parentId !== undefined ? { parentId } : {});
        if (Object.keys(send).length) await api.patch(`/entities/${e.id}`, send);
    }
    for (const b of before) if (b.id && !now.some(e => e.id === b.id)) await api.del(`/entities/${b.id}`);
}

/** Save what changed. Shows the reason and goes back to the server's values if anything is refused. */
export async function saveCompanySettings(): Promise<boolean> {
    if (!last) return false;
    const was = last;
    try {
        const changed = COMPANY_FIELDS.filter(f => SETTINGS[f] !== undefined && !same(SETTINGS[f], was.fields[f]) && mayChange(f));
        if (changed.length) await api.patch('/company-settings', Object.fromEntries(changed.map(f => [f, SETTINGS[f]])));
        if (holds('admin.settings')) {
            await saveEntities(was.entities, SETTINGS.entities || []);
            const now = ratesOf(SETTINGS.fxHistory);
            const add = [...now].filter(([k, r]) => was.rates.get(k) !== r).map(([k, rate]) => { const [date, currency] = k.split('|'); return { date, currency, rate }; });
            const remove = [...was.rates.keys()].filter(k => !now.has(k)).map(k => { const [date, currency] = k.split('|'); return { date, currency }; });
            if (add.length) await api.post('/fx-rates', add);
            if (remove.length) await api.post('/fx-rates/remove', remove);
        }
        await loadCompanySettings();
        return true;
    } catch (e) {
        toast(e instanceof ApiError ? `Not saved: ${e.message}` : 'Not saved. Check your connection and try again.');
        await loadCompanySettings().catch(() => { /* keep what is shown; the next load corrects it */ });
        return false;
    }
}
