import { useRef, useState, type ChangeEvent } from 'react';
import type { ScreenProps } from './registry';
import { CURRENCIES, SETTINGS, type AccountKey, type AppSettings } from '../domain/settings';
import { num as N } from '../domain/engine';
import { Store } from '../domain/store';
import { gate } from '../domain/enterprise';
import { applyTheme } from '../domain/startup';
import { DEFAULT_SCHEME, SCHEMES, activeScheme, colorChoice, readable, setColors, type ColorChoice } from '../domain/colors';
import { loadSample } from '../domain/sample';
import { restoreToServer, type BackupData } from '../domain/serverBackup';
import { go } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { confirmDialog } from '../components/common/ConfirmDialog';
import { toast } from '../utils/uiStore';
import { saveFile } from '../utils/files';
import { todayISO } from '../utils/dates';
import type { Lease } from '../types/lease';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The option a select shows: the matching value, or the first option as the browser does. */
const pick = (value: string, options: string[]): string => options.includes(value) ? value : options[0];

function initialVals(): Record<string, string> {
    const S = SETTINGS;
    const v: Record<string, string> = {
        's-entity': S.entity,
        's-fc': pick(S.functionalCurrency, CURRENCIES),
        's-fy': pick(String(Number(S.fyEndMonth)), MONTHS.map((_, i) => String(i + 1))),
        's-unit': S.displayUnit == 1000 ? '1000' : S.displayUnit == 1e6 ? '1000000' : '1',
        's-grp': S.numberGrouping === 'south-asian' ? 'south-asian' : 'international',
        's-name': S.userName || '',
        's-theme': pick(S.theme, ['light', 'dark', 'system']),
        's-conv': S.rateConvention === 'nominal' ? 'nominal' : 'effective',
        's-int': S.interestCashFlow === 'operating' ? 'operating' : 'financing',
        's-rate': String(S.defaultRate || ''),
        's-major': String(S.majorPartPct),
        's-sub': String(S.substantiallyAllPct),
        's-lv': String(S.lowValueThreshold),
        's-lvc': pick(S.lowValueCurrency, CURRENCIES),
    };
    CURRENCIES.forEach(c => { v['fx-' + c] = String(S.fx[c] ?? ''); });
    Object.entries(S.accounts).forEach(([k, a]) => { v['ac-' + k] = a; });
    return v;
}

/** Primary and sidebar colours: a hand-picked scheme or your own pair. Applied at once and kept in this browser. */
function ColorSettings() {
    const [pick, setPick] = useState<ColorChoice>(colorChoice);
    const shown = activeScheme();
    const [accent, setAccent] = useState(shown.accent[0]);
    const [side, setSide] = useState(shown.side[0]);
    const choose = (next: ColorChoice) => { setColors(next); setPick(colorChoice()); };
    const custom = (a: string, s: string) => { setAccent(a); setSide(s); choose({ scheme: 'custom', accent: a, side: s }); };
    const fixed = pick.scheme === 'custom' && readable(accent, side).changed;
    return (
        <section className="card pad"><h3>Colours</h3>
            <p className="note" style={{ marginBottom: '12px' }}>The primary colour is used for buttons, links, tabs and highlights; the sidebar colour for the navigation panel. Both adapt to the light and dark themes. Saved in this browser for you only.</p>
            <div className="scheme-grid" role="group" aria-label="Colour scheme">
                {SCHEMES.map(sc => {
                    const on = pick.scheme === sc.id;
                    return (
                        <button key={sc.id} type="button" className="scheme" aria-pressed={on} onClick={() => { setAccent(sc.accent[0]); setSide(sc.side[0]); choose({ scheme: sc.id }); }}>
                            <span className="scheme-preview" aria-hidden="true">
                                <span className="scheme-side" style={{ background: sc.side[0] }}><i /><i /><i /></span>
                                <span className="scheme-main"><i style={{ background: sc.accent[0] }} /><b /><b /></span>
                            </span>
                            <span className="scheme-name">{sc.name}{sc.id === DEFAULT_SCHEME ? ' (default)' : ''}</span>
                        </button>
                    );
                })}
            </div>
            <div className="row4" style={{ marginTop: '14px' }}>
                <div className="fg"><label htmlFor="c-accent">Primary colour</label><input type="color" id="c-accent" className="color-input" value={accent} onChange={e => custom(e.target.value, side)} /></div>
                <div className="fg"><label htmlFor="c-side">Sidebar colour</label><input type="color" id="c-side" className="color-input" value={side} onChange={e => custom(accent, e.target.value)} /></div>
                <div className="fg" style={{ gridColumn: 'span 2', alignSelf: 'end' }}>
                    {pick.scheme === 'custom' && <button type="button" className="btn btn-ghost" onClick={() => { setAccent(SCHEMES[0].accent[0]); setSide(SCHEMES[0].side[0]); choose({ scheme: DEFAULT_SCHEME }); }}>Reset to default</button>}
                </div>
            </div>
            {fixed && <div className="hint">Your colours were darkened slightly so white text on buttons and in the sidebar stays readable.</div>}
        </section>
    );
}

function SettingsForm({ onSaved }: { onSaved: () => void }) {
    const S = SETTINGS;
    const acc = Object.entries(S.accounts) as [AccountKey, string][];
    const [vals, setVals] = useState(initialVals);
    const [checks, setChecks] = useState({ appr: !!S.requireApproval, seg: !!S.segregateApproval });
    const fileRef = useRef<HTMLInputElement>(null);
    const bind = (id: string) => ({ id, value: vals[id], onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { const x = e.target.value; setVals(o => ({ ...o, [id]: x })); } });
    const v = (id: string) => vals[id];

    const save = async () => {
        Object.assign(SETTINGS, { entity: v('s-entity'), functionalCurrency: v('s-fc'), fyEndMonth: Number(v('s-fy')), displayUnit: Number(v('s-unit')), numberGrouping: v('s-grp') as AppSettings['numberGrouping'], userName: v('s-name'), theme: v('s-theme') as AppSettings['theme'], rateConvention: v('s-conv') as AppSettings['rateConvention'], interestCashFlow: v('s-int') as AppSettings['interestCashFlow'], defaultRate: v('s-rate') === '' ? '' : Number(v('s-rate')), majorPartPct: Number(v('s-major')), substantiallyAllPct: Number(v('s-sub')), lowValueThreshold: Number(v('s-lv')), lowValueCurrency: v('s-lvc'), requireApproval: checks.appr, segregateApproval: checks.seg });
        CURRENCIES.forEach(c => { const x = N(v('fx-' + c)); if (x) SETTINGS.fx[c] = x; });
        acc.forEach(([k]) => SETTINGS.accounts[k] = v('ac-' + k));
        const ok = await Store.saveSettings(); applyTheme(); if (ok) toast('Settings saved'); onSaved();
    };
    const restore = async (e: ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files && e.target.files[0]; if (!f) return;
        try {
            const d = JSON.parse(await f.text()) as { leases?: unknown; settings?: Partial<AppSettings> }; if (!Array.isArray(d.leases)) throw new Error('No leases in file');
            const leases = d.leases as Lease[];
            if (Store.mode === 'api') { confirmDialog('Restore backup', `Restore ${leases.length} leases from ${f.name}? Leases with the same ID are replaced.`, 'Restore', async () => { toast(await restoreToServer(d as BackupData, f.name)); go('dashboard', {}, { reset: true }); }, false); return; }
            confirmDialog('Restore backup', `Restore ${leases.length} leases from ${f.name}? Leases with the same ID are replaced.`, 'Restore', async () => { for (const l of leases) await Store.save(l); if (d.settings) { Object.assign(SETTINGS, d.settings); await Store.saveSettings(); } toast('Backup restored'); go('dashboard', {}, { reset: true }); }, false);
        } catch { toast('That file is not a valid backup.'); }
    };
    const clearAll = () => confirmDialog('Delete all leases', `Delete all ${Store.leases.length} leases${Store.mode === 'db' || Store.mode === 'api' ? ' for everyone in your company' : ''}? Download a backup first. This cannot be undone.`, 'Delete all leases', async () => { let left = 0; for (const l of Store.all.slice()) if (!await Store.remove(l.id)) left++; toast(left ? `${left} leases could not be deleted` : 'All leases deleted'); go('dashboard', {}, { reset: true }); });

    return (
        <div className="stack" style={{ maxWidth: '980px' }}>
            <section className="card pad"><h3>Entity and reporting</h3>
                <div className="row4">
                    <div className="fg"><label htmlFor="s-entity">Entity name</label><input {...bind('s-entity')} /></div>
                    <div className="fg"><label htmlFor="s-fc">Functional currency</label><select {...bind('s-fc')}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></div>
                    <div className="fg"><label htmlFor="s-fy">Financial year ends</label><select {...bind('s-fy')}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></div>
                    <div className="fg"><label htmlFor="s-unit">Show amounts</label><select {...bind('s-unit')}><option value="1">In units</option><option value="1000">In thousands</option><option value="1000000">In millions</option></select></div>
                </div>
                <div className="row4">
                    <div className="fg"><label htmlFor="s-grp">Number grouping</label><select {...bind('s-grp')}><option value="international">1,234,567</option><option value="south-asian">12,34,567 (lakh, crore)</option></select></div>
                    <div className="fg"><label htmlFor="s-name">Your name (when not signed in)</label><input {...bind('s-name')} /></div>
                    <div className="fg"><label htmlFor="s-theme">Theme</label><select id="s-theme" value={vals['s-theme']} onChange={e => { const x = e.target.value; setVals(o => ({ ...o, 's-theme': x })); SETTINGS.theme = x as AppSettings['theme']; applyTheme(); }}><option value="light">Light</option><option value="dark">Dark</option><option value="system">Match system</option></select></div>
                    <div></div>
                </div>
            </section>
            <ColorSettings />
            <section className="card pad"><h3>Accounting policies</h3>
                <div className="row3">
                    <div className="fg"><label htmlFor="s-conv">Discount rate convention</label><select {...bind('s-conv')}><option value="effective">Effective annual: (1+r)^(1/12)-1</option><option value="nominal">Nominal: r ÷ payments per year</option></select><div className="hint">The IASB illustrative examples use effective. Both agree for annual payments.</div></div>
                    <div className="fg"><label htmlFor="s-int">Interest paid in the cash flow statement</label><select {...bind('s-int')}><option value="financing">Financing activities</option><option value="operating">Operating activities</option></select></div>
                    <div className="fg"><label htmlFor="s-rate">Default incremental borrowing rate %</label><input type="number" step="any" {...bind('s-rate')} /><div className="hint">Pre-filled on new leases; review per lease.</div></div>
                </div>
                <div className="row4">
                    <div className="fg"><label htmlFor="s-major">Lessor test: major part of life %</label><input type="number" {...bind('s-major')} /></div>
                    <div className="fg"><label htmlFor="s-sub">Lessor test: substantially all of fair value %</label><input type="number" {...bind('s-sub')} /></div>
                    <div className="fg"><label htmlFor="s-lv">Low-value threshold</label><input type="number" {...bind('s-lv')} /></div>
                    <div className="fg"><label htmlFor="s-lvc">Threshold currency</label><select {...bind('s-lvc')}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></div>
                </div>
            </section>
            <section className="card pad"><h3>Controls</h3>
                <label className="check" style={{ marginBottom: '8px' }}><input type="checkbox" id="s-appr" checked={checks.appr} onChange={e => { const x = e.target.checked; setChecks(o => ({ ...o, appr: x })); }} /> New leases and changes need approval before they affect balances</label>
                <label className="check"><input type="checkbox" id="s-seg" checked={checks.seg} onChange={e => { const x = e.target.checked; setChecks(o => ({ ...o, seg: x })); }} /> The person who submits cannot approve (applies when people are signed in)</label>
            </section>
            <section className="card pad"><h3>Exchange rates to {S.functionalCurrency}</h3><p className="note" style={{ marginBottom: '10px' }}>Used to add up leases in other currencies on the dashboard and in reports. Each lease is still measured in its own currency.</p>
                <div className="row4">{CURRENCIES.map(c => <div key={c} className="fg"><label htmlFor={'fx-' + c}>1 {c} =</label><input type="number" step="any" {...bind('fx-' + c)} /></div>)}</div>
            </section>
            <section className="card pad"><h3>Chart of accounts</h3><p className="note" style={{ marginBottom: '10px' }}>Account names used in journal entries and exports. Match them to your ledger codes.</p>
                <div className="row3">{acc.map(([k]) => <div key={k} className="fg"><label htmlFor={'ac-' + k} style={{ fontWeight: 400, color: 'var(--muted)' }}>{k}</label><input {...bind('ac-' + k)} /></div>)}</div>
            </section>
            <section className="card pad"><h3>Data</h3><p className="note" style={{ marginBottom: '10px' }}>{`${Store.mode === 'db' ? 'Leases are saved in this page’s shared workspace and are visible to everyone you share the page with.' : Store.mode === 'api' ? 'Leases are saved on your company’s server.' : Store.mode === 'local' ? 'Leases are saved in this browser only.' : 'Leases are kept for this session only.'} ${Store.all.length} leases.`}</p>
                <div className="btn-row">
                    <button className="btn btn-ghost" id="d-backup" onClick={() => saveFile(`IFRS16_backup_${todayISO()}.json`, JSON.stringify({ version: 2, exported: new Date().toISOString(), settings: SETTINGS, leases: Store.all }, null, 1))}>Download backup (JSON)</button>
                    <button className="btn btn-ghost" id="d-restore" {...gate('admin.data')} onClick={() => fileRef.current?.click()}>Restore from backup</button>
                    <input type="file" id="d-file" accept=".json" hidden ref={fileRef} onChange={restore} />
                    <button className="btn btn-ghost" id="d-sample" {...gate('admin.data')} onClick={() => { void loadSample(); }}>Add sample portfolio</button>
                    <button className="btn btn-danger" id="d-clear" {...gate('admin.data')} onClick={clearAll}>Delete all leases</button>
                </div>
            </section>
            <div className="form-actions" style={{ border: 'none' }}><button className="btn" id="s-save" onClick={() => { void save(); }}>Save settings</button></div>
        </div>
    );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function SettingsPage(_props: ScreenProps<'settings'>) {
    useAppState();
    // The original re-rendered the form from SETTINGS after a save.
    const [formKey, setFormKey] = useState(0);
    return <SettingsForm key={formKey} onSaved={() => setFormKey(k => k + 1)} />;
}
