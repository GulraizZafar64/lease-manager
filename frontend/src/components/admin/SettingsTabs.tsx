import { useState } from 'react';
import { num } from '../../domain/engine';
import { CURRENCIES, CURRENCY_NAMES, SETTINGS, type BankAccount, type EntityRecord } from '../../domain/settings';
import { Store } from '../../domain/store';
import { FX_MISSING, entities, guard, logHistory, policy, presentationCcy, type PolicyType, roleDefs, roleLabel, rolePerms } from '../../domain/enterprise';
import { ibanValid } from '../../domain/banking';
import { INTEGRATION_STATUS } from '../../domain/erp';
import { parseDate } from '../../domain/extractor';
import { refresh } from '../../domain/nav';
import { useAppState } from '../../hooks/useAppState';
import { toast } from '../../utils/uiStore';
import { deepClone } from '../../utils/format';
import { fmtDate } from '../../utils/dates';
import { saveSettingsAudited } from './common';
import type { RoleKey } from '../../types/enterprise';

/* ---- Approval policy ---- */
const POLICY_TYPES: [PolicyType, string][] = [['lease', 'New leases (initial liability or net investment)'], ['change', 'Remeasurements and modifications (size of adjustment)'], ['batch', 'Payment batches (total)'], ['draft', 'AI-drafted disclosures']];
/** Roles that can approve: the built-in approvers, plus any role given the Approve permission. */
const approverRoles = (): RoleKey[] => roleDefs().filter(r => rolePerms(r.id).includes('approve')).map(r => r.id);
interface TierDraft { upTo: string; approvals: string; roles: string[] }

export function PolicyTab() {
    useAppState();
    const pol = policy();
    const [tiers, setTiers] = useState<Record<string, TierDraft[]>>(() => Object.fromEntries(POLICY_TYPES.map(([k]) => [k, pol[k].map(t => ({ upTo: String(t.upTo ?? ''), approvals: String(t.approvals), roles: t.roles.slice() }))])));
    const [appr, setAppr] = useState(!!SETTINGS.requireApproval);
    const [seg, setSeg] = useState(!!SETTINGS.segregateApproval);
    const [lock, setLock] = useState(SETTINGS.lockedThrough || '');
    const [pen, setPen] = useState(String(SETTINGS.exitPenaltyMonths || 2));
    const setTier = (k: string, i: number, patch: Partial<TierDraft>) => setTiers(prev => ({ ...prev, [k]: prev[k].map((t, j) => j === i ? { ...t, ...patch } : t) }));
    const save = async () => {
        if (!guard('admin.settings')) return;
        POLICY_TYPES.forEach(([k]) => tiers[k].forEach((d, i) => { const t = pol[k][i]; if (!t) return; t.upTo = d.upTo === '' ? null : num(d.upTo); t.approvals = Math.max(1, num(d.approvals)); t.roles = approverRoles().filter(r => d.roles.includes(r)); if (!t.roles.length) t.roles = ['admin', 'superadmin']; }));
        Object.assign(SETTINGS, { requireApproval: appr, segregateApproval: seg, lockedThrough: lock, exitPenaltyMonths: num(pen) || 2 });
        await saveSettingsAudited(`Approval policy saved; period lock ${SETTINGS.lockedThrough || 'none'}`);
    };
    return (
        <>
            <p style={{ marginBottom: '12px' }}>Tiers by amount in {SETTINGS.functionalCurrency}. An item needs the number of distinct approvers shown, each holding one of the roles, none of whom prepared it, and each with an approval limit at least the amount.</p>
            {POLICY_TYPES.map(([k, label]) => <fieldset key={k}><legend>{label}</legend>{tiers[k].map((t, i) => (
                <div key={i} className="row4" data-tier={`${k}:${i}`}><div className="fg"><label>Up to (blank = no upper limit)</label><input type="number" data-x="upTo" value={t.upTo} onChange={e => setTier(k, i, { upTo: e.target.value })} /></div><div className="fg"><label>Approvals needed</label><input type="number" min="1" max="5" data-x="approvals" value={t.approvals} onChange={e => setTier(k, i, { approvals: e.target.value })} /></div><div className="fg" style={{ gridColumn: 'span 2' }}><label>Approver roles</label><div className="btn-row">{approverRoles().map(r => <label key={r} className="check"><input type="checkbox" data-role={r} checked={t.roles.includes(r)} onChange={e => setTier(k, i, { roles: e.target.checked ? t.roles.concat([r]) : t.roles.filter(x => x !== r) })} /> {roleLabel(r)}</label>)}</div></div></div>
            ))}</fieldset>)}
            <div className="row3"><label className="check"><input type="checkbox" id="po-appr" checked={appr} onChange={e => setAppr(e.target.checked)} /> Approval required before items affect balances</label><label className="check"><input type="checkbox" id="po-seg" checked={seg} onChange={e => setSeg(e.target.checked)} /> Maker cannot be checker</label><div></div></div>
            <div className="row3"><div className="fg"><label htmlFor="po-lock">Periods locked up to and including</label><input type="date" id="po-lock" value={lock} onChange={e => setLock(e.target.value)} /><div className="hint">Changes, payments and approvals dated on or before this are blocked unless a user has the override permission (recorded in the audit log).</div></div><div className="fg"><label htmlFor="po-pen">Scenario exit penalty (months of rent)</label><input type="number" id="po-pen" value={pen} onChange={e => setPen(e.target.value)} /></div><div></div></div>
            <div className="form-actions"><button className="btn" id="po-save" onClick={save}>Save policy</button></div>
        </>
    );
}

/* ---- Entities ---- */
type EntityField = keyof EntityRecord;
export function EntitiesTab() {
    useAppState();
    const ents = entities();
    const [draft, setDraft] = useState<EntityRecord[]>(() => ents.map(e => ({ ...e, country: e.country || '' })));
    const resync = () => setDraft(ents.map(e => ({ ...e, country: e.country || '' })));
    const setField = (i: number, k: EntityField, v: string) => setDraft(prev => prev.map((e, j) => j === i ? { ...e, [k]: v } : e));
    const add = () => { ents.push({ name: 'New entity', code: 'E' + String(ents.length + 1).padStart(2, '0'), functionalCurrency: SETTINGS.functionalCurrency, parent: ents[0].name, country: '' }); resync(); refresh(); };
    const del = (i: number) => { ents.splice(i, 1); resync(); refresh(); };
    const save = async () => {
        if (!guard('admin.settings')) return;
        const renames: [string, string][] = [];
        draft.forEach((d, i) => { const e = ents[i]; if (!e) return; const old = e.name; (['name', 'code', 'functionalCurrency', 'parent', 'country'] as EntityField[]).forEach(k => { e[k] = String(d[k] ?? '').trim(); }); if (old !== e.name) renames.push([old, e.name]); });
        if (new Set(ents.map(e => e.name)).size !== ents.length) return toast('Entity names must be unique.');
        for (const [a, b] of renames) { if (Store.mode !== 'api') for (const l of Store.all.filter(l => l.entity === a)) { const l2 = deepClone(l); l2.entity = b; logHistory(l2, `Entity renamed from ${a} to ${b}`); await Store.save(l2); } ents.forEach(e => { if (e.parent === a) e.parent = b; }); }
        await saveSettingsAudited(`Entities saved (${ents.length})`);
        if (Store.mode === 'api') Store.remapEntities(); // leases are linked to entities by id on the server
        resync(); refresh();
    };
    return (
        <>
            <p style={{ marginBottom: '12px' }}>Legal entities and subsidiaries. Each lease belongs to one entity (its “Reporting entity” field). Users can be limited to entities. Leases in a currency other than the entity’s functional currency are retranslated under IAS 21.</p>
            <div className="scroll-x"><table><thead><tr><th>Name</th><th>Code</th><th>Functional currency</th><th>Parent</th><th>Country</th><th className="num">Leases</th><th></th></tr></thead><tbody id="en-rows">
                {ents.map((e, i) => { const d = draft[i] || e; return (
                    <tr key={i} data-i={i}><td><input data-x="name" value={d.name} onChange={x => setField(i, 'name', x.target.value)} /></td><td><input data-x="code" value={d.code} style={{ width: '80px' }} onChange={x => setField(i, 'code', x.target.value)} /></td><td><select data-x="functionalCurrency" value={d.functionalCurrency} onChange={x => setField(i, 'functionalCurrency', x.target.value)}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></td><td><select data-x="parent" value={ents.some((x, j) => j !== i && x.name === d.parent) ? d.parent : ''} onChange={x => setField(i, 'parent', x.target.value)}><option value="">None (top)</option>{ents.filter((_, j) => j !== i).map((x, j) => <option key={j}>{x.name}</option>)}</select></td><td><input data-x="country" value={d.country || ''} onChange={x => setField(i, 'country', x.target.value)} /></td><td className="num">{Store.all.filter(l => l.entity === e.name).length}</td><td>{Store.all.some(l => l.entity === e.name) ? null : <button className="btn btn-danger btn-sm" data-del={i} onClick={() => del(i)}>Remove</button>}</td></tr>
                ); })}</tbody></table></div>
            <div className="form-actions"><button className="btn btn-ghost" id="en-add" onClick={add}>Add entity</button><button className="btn" id="en-save" onClick={save}>Save entities</button></div>
        </>
    );
}

/* ---- Currencies and rates ---- */
export function FxTab() {
    useAppState();
    const hist = (SETTINGS.fxHistory = SETTINGS.fxHistory || []).sort((a, b) => b.date.localeCompare(a.date));
    const used = [...new Set(Store.all.map(l => l.currency).concat(entities().map(e => e.functionalCurrency), [presentationCcy()]))];
    const shown = used.concat(CURRENCIES.filter(c => !used.includes(c)));
    const F = SETTINGS.functionalCurrency;
    const [rates, setRates] = useState<Record<string, string>>(() => Object.fromEntries(shown.map(c => [c, c === F ? '1' : String(SETTINGS.fx[c] ?? '')])));
    const [paste, setPaste] = useState('');
    const rateOf = (c: string) => c === F ? '1' : (rates[c] ?? String(SETTINGS.fx[c] ?? ''));
    const onPres = async (v: string) => { if (!guard('admin.settings')) return; SETTINGS.presentationCurrency = v; await saveSettingsAudited(`Presentation currency ${v}`); };
    const onSave = async () => { if (!guard('admin.settings')) return; CURRENCIES.forEach(c => { const v = rateOf(c); if (v !== '' && c !== F) SETTINGS.fx[c] = num(v); else if (v === '') delete SETTINGS.fx[c]; }); FX_MISSING.clear(); await saveSettingsAudited('Current exchange rates updated'); };
    const onAdd = async () => {
        if (!guard('admin.settings')) return;
        let n = 0; paste.split(/\n/).forEach(line => { const [d, c, r] = line.split(/[,;\t]/).map(s => s.trim()); const date = parseDate(d || '') || d; if (/^\d{4}-\d{2}-\d{2}$/.test(date) && CURRENCIES.includes((c || '').toUpperCase()) && num(r) > 0) { let h = hist.find(x => x.date === date); if (!h) { h = { date, rates: {} }; hist.push(h); } h.rates[c.toUpperCase()] = num(r); n++; } });
        if (!n) return toast('No valid rows. Use: date, currency, rate.');
        await saveSettingsAudited(`${n} dated exchange rates added`); setPaste(''); refresh();
    };
    const onDel = async (i: number) => { hist.splice(i, 1); await saveSettingsAudited('Dated rate deleted'); refresh(); };
    return (
        <>
            <div className="row3"><div className="fg"><label htmlFor="fx-base">Group base currency</label><input id="fx-base" value={F} readOnly /><div className="hint">Rates are units of {F} per one unit of each currency. Change the base in Settings.</div></div><div className="fg"><label htmlFor="fx-pres">Presentation currency (dashboards and reports)</label><select id="fx-pres" value={presentationCcy()} onChange={e => onPres(e.target.value)}>{CURRENCIES.map(c => <option key={c} value={c}>{c} {CURRENCY_NAMES[c]}</option>)}</select></div><div></div></div>
            <h3>Current rates</h3><p className="note" style={{ marginBottom: '8px' }}>Used when no dated rate applies. Currencies in use are listed first. No rates are assumed: enter rates from your treasury source (for Pakistan, the State Bank of Pakistan or your bank).</p>
            <div className="row4">{shown.map(c => <div key={c} className="fg"><label htmlFor={`fxc-${c}`} title={CURRENCY_NAMES[c]}>1 {c}{used.includes(c) ? ' (in use)' : ''}</label><input type="number" step="any" id={`fxc-${c}`} value={rateOf(c)} readOnly={c === F} onChange={e => { const v = e.target.value; setRates(prev => ({ ...prev, [c]: v })); }} /></div>)}</div>
            <div className="form-actions"><button className="btn" id="fx-save" onClick={onSave}>Save current rates</button></div>
            <h3>Dated closing rates</h3><p className="note" style={{ marginBottom: '8px' }}>Add month-end closing rates for historical reporting and IAS 21 revaluation. Average rates for a period are the mean of dated rates in it. Paste rows as “date, currency, rate”.</p>
            <textarea id="fx-paste" rows={4} placeholder={'2026-06-30, USD, 278.40\n2026-06-30, EUR, 301.10'} value={paste} onChange={e => setPaste(e.target.value)}></textarea><div className="form-actions" style={{ border: 'none', marginTop: '6px', paddingTop: 0 }}><button className="btn btn-ghost" id="fx-add" onClick={onAdd}>Add dated rates</button></div>
            <div className="scroll-x"><table><thead><tr><th>Date</th><th>Rates</th><th></th></tr></thead><tbody>{hist.length ? hist.map((h, i) => <tr key={h.date}><td>{fmtDate(h.date)}</td><td className="wrap">{Object.entries(h.rates).map(([k, v]) => `${k} ${v}`).join(', ')}</td><td><button className="btn btn-danger btn-sm" data-dh={i} onClick={() => onDel(i)}>Delete</button></td></tr>) : <tr><td colSpan={3} className="empty">No dated rates.</td></tr>}</tbody></table></div>
        </>
    );
}

/* ---- Integrations: bank accounts and what each connection needs ---- */
type AcctField = 'name' | 'bank' | 'iban' | 'swift' | 'currency' | 'gl';
const ACCT_FIELDS: AcctField[] = ['name', 'bank', 'iban', 'swift', 'currency', 'gl'];
const acctDraft = (a: BankAccount): Record<AcctField, string> => ({ name: a.name, bank: a.bank || '', iban: a.iban || '', swift: a.swift || '', currency: a.currency, gl: a.gl || SETTINGS.accounts.cash });

export function IntegrationsTab() {
    useAppState();
    const accts = SETTINGS.bankAccounts = SETTINGS.bankAccounts || [];
    const [draft, setDraft] = useState(() => accts.map(acctDraft));
    const resync = () => setDraft(accts.map(acctDraft));
    const setField = (i: number, k: AcctField, v: string) => setDraft(prev => prev.map((a, j) => j === i ? { ...a, [k]: v } : a));
    const add = () => { accts.push({ name: 'Operating account', bank: '', iban: '', swift: '', currency: SETTINGS.functionalCurrency, gl: SETTINGS.accounts.cash }); resync(); refresh(); };
    const del = (i: number) => { accts.splice(i, 1); resync(); refresh(); };
    const save = async () => {
        if (!guard('admin.settings')) return;
        let bad = '';
        draft.forEach((d, i) => { const a = accts[i]; if (!a) return; ACCT_FIELDS.forEach(k => { a[k] = d[k].trim(); }); a.iban = a.iban.replace(/\s+/g, '').toUpperCase(); if (a.iban && !ibanValid(a.iban)) bad = a.name; });
        if (bad) return toast(`The IBAN for ${bad} is not valid.`);
        await saveSettingsAudited(`Bank accounts saved (${accts.length})`);
    };
    return (
        <>
            <h3>Bank accounts</h3><p className="note" style={{ marginBottom: '8px' }}>Accounts that pay leases and receive lease income; used for statement imports and payment files.</p>
            <div className="scroll-x"><table><thead><tr><th>Name</th><th>Bank</th><th>IBAN</th><th>SWIFT</th><th>Currency</th><th>GL account</th><th></th></tr></thead><tbody id="ba-rows">{accts.map((a, i) => { const d = draft[i] || acctDraft(a); return (
                <tr key={i} data-i={i}><td><input data-x="name" value={d.name} onChange={e => setField(i, 'name', e.target.value)} /></td><td><input data-x="bank" value={d.bank} onChange={e => setField(i, 'bank', e.target.value)} /></td><td><input data-x="iban" value={d.iban} onChange={e => setField(i, 'iban', e.target.value)} /></td><td><input data-x="swift" value={d.swift} style={{ width: '110px' }} onChange={e => setField(i, 'swift', e.target.value)} /></td><td><select data-x="currency" value={d.currency} onChange={e => setField(i, 'currency', e.target.value)}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></td><td><input data-x="gl" value={d.gl} onChange={e => setField(i, 'gl', e.target.value)} /></td><td><button className="btn btn-danger btn-sm" data-del={i} onClick={() => del(i)}>Remove</button></td></tr>
            ); })}</tbody></table></div>
            <div className="form-actions"><button className="btn btn-ghost" id="ba-add" onClick={add}>Add account</button><button className="btn" id="ba-save" onClick={save}>Save accounts</button></div>
            <h3 style={{ marginTop: '8px' }}>What is connected, and what needs credentials</h3>
            <div className="scroll-x"><table><thead><tr><th>Integration</th><th>Available now</th><th>For live connection you need</th></tr></thead><tbody>
                {INTEGRATION_STATUS.map(r => <tr key={r[0]}><td>{r[0]}</td><td className="wrap">{r[1]}</td><td className="wrap">{r[2]}</td></tr>)}</tbody></table></div>
        </>
    );
}
