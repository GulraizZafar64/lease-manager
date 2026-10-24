/* Sortable, filterable table with Excel-style column filters, a search box,
   a record count and optional totals row. */
import { useEffect, useMemo, useState, type MutableRefObject, type ReactNode } from 'react';
import { popover } from '../../utils/uiStore';
import { fmtNum } from '../../utils/format';
import type { SheetValue } from '../../utils/files';

export type ColumnType = 'text' | 'enum' | 'number' | 'date';
export interface Column<T> {
    key: string;
    label: string;
    type?: ColumnType;
    /** Value used for search, sort, filter and export (defaults to row[key]). */
    value?: (row: T) => unknown;
    /** Text shown in the cell when there is no `render`. */
    format?: (v: unknown) => string;
    /** Cell content. Buttons inside should call e.stopPropagation() so the row click does not fire. */
    render?: (row: T) => ReactNode;
    total?: boolean;
    noFilter?: boolean;
    noExport?: boolean;
}
export interface DataTableApi { exportRows(): SheetValue[][] }

type Filter =
    | { type: 'set'; values: Set<string> }
    | { type: 'cmp'; op: 'eq' | 'gt' | 'lt' | 'between'; a: string; b: string }
    | { type: 'range'; from: string; to: string };
type Sort = { key: string; dir: 'asc' | 'desc' } | null;

const FUNNEL = <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z" fill="currentColor" /></svg>;
const SORT_LABELS: Record<ColumnType, [string, string]> = { text: ['Sort A to Z', 'Sort Z to A'], enum: ['Sort A to Z', 'Sort Z to A'], number: ['Sort smallest to largest', 'Sort largest to smallest'], date: ['Sort oldest to newest', 'Sort newest to oldest'] };
const isBlank = (v: unknown) => v === null || v === undefined || v === '';

interface DataTableProps<T> {
    columns: Column<T>[];
    rows: T[];
    search?: boolean;
    searchPlaceholder?: string;
    emptyText?: string;
    onRowClick?: (row: T) => void;
    rowClass?: (row: T) => string;
    toolbarExtra?: ReactNode;
    /** Receives exportRows(), which exports the rows currently shown. */
    apiRef?: MutableRefObject<DataTableApi | null>;
}

export function DataTable<T>({ columns, rows, search = true, searchPlaceholder = 'Search...', emptyText = 'No records match the current filters.', onRowClick, rowClass, toolbarExtra, apiRef }: DataTableProps<T>) {
    const [filters, setFilters] = useState<Record<string, Filter>>({});
    const [sort, setSort] = useState<Sort>(null);
    const [q, setQ] = useState('');
    const val = (row: T, col: Column<T>): unknown => col.value ? col.value(row) : (row as Record<string, unknown>)[col.key];

    const view = useMemo(() => {
        const query = q.trim().toLowerCase();
        const matches = (row: T) => {
            if (query) {
                const hay = columns.map(c => String(val(row, c) ?? '')).join(' ').toLowerCase();
                if (!hay.includes(query)) return false;
            }
            for (const key in filters) {
                const c = columns.find(x => x.key === key);
                if (!c) continue;
                const f = filters[key], v = val(row, c);
                if (f.type === 'set') { if (!f.values.has(isBlank(v) ? '(Blank)' : String(v))) return false; }
                else if (f.type === 'cmp') {
                    if (isBlank(v)) return false;
                    const n = Number(v), a = Number(f.a), b = Number(f.b);
                    if (f.op === 'eq' && !(n === a)) return false;
                    if (f.op === 'gt' && !(n > a)) return false;
                    if (f.op === 'lt' && !(n < a)) return false;
                    if (f.op === 'between' && !(n >= Math.min(a, b) && n <= Math.max(a, b))) return false;
                } else {
                    if (!v) return false;
                    if (f.from && String(v) < f.from) return false;
                    if (f.to && String(v) > f.to) return false;
                }
            }
            return true;
        };
        let out = rows.filter(matches);
        if (sort) {
            const c = columns.find(x => x.key === sort.key), d = sort.dir === 'asc' ? 1 : -1;
            if (c) out = out.slice().sort((a, b) => {
                const x = val(a, c), y = val(b, c);
                if (x === y) return 0;
                if (isBlank(x)) return 1;
                if (isBlank(y)) return -1;
                return (c.type === 'number' ? Number(x) - Number(y) : String(x).localeCompare(String(y), undefined, { numeric: true })) * d;
            });
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, columns, filters, sort, q]);

    useEffect(() => {
        if (!apiRef) return;
        apiRef.current = {
            exportRows() {
                const cols = columns.filter(c => !c.noExport && !c.key.startsWith('_'));
                return [cols.map(c => c.label) as SheetValue[]].concat(view.map(r => cols.map(c => {
                    const v = val(r, c);
                    return c.type === 'number' ? (isBlank(v) ? '' : Number(v)) : ((v ?? '') as SheetValue);
                })));
            },
        };
    });

    const toggleSort = (c: Column<T>) => {
        if (!sort || sort.key !== c.key) setSort({ key: c.key, dir: 'asc' });
        else if (sort.dir === 'asc') setSort({ key: c.key, dir: 'desc' });
        else setSort(null);
    };
    const openFilter = (c: Column<T>, anchor: HTMLElement) => {
        const distinct = [...new Set(rows.map(r => { const v = val(r, c); return isBlank(v) ? '(Blank)' : String(v); }))]
            .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
        popover.open(anchor, <FilterPanel
            type={c.type || 'text'} current={sort && sort.key === c.key ? sort.dir : ''} existing={filters[c.key]} distinct={distinct}
            onSort={dir => { setSort({ key: c.key, dir }); popover.close(); }}
            onClear={() => { setFilters(f => { const n = { ...f }; delete n[c.key]; return n; }); popover.close(); }}
            onApply={f => { setFilters(prev => { const n = { ...prev }; if (f) n[c.key] = f; else delete n[c.key]; return n; }); popover.close(); }}
        />);
    };

    const total = rows.length;
    const hasState = Object.keys(filters).length > 0 || !!sort || !!q;
    const showTotals = columns.some(c => c.total) && view.length > 0;

    return (
        <>
            <div className="dt-toolbar">
                {search && <input type="search" className="dt-search filter-input" placeholder={searchPlaceholder} aria-label="Search" value={q} onChange={e => setQ(e.target.value)} />}
                <span className="dt-count" aria-live="polite">{view.length === total ? `${total} record${total === 1 ? '' : 's'}` : `Showing ${view.length} of ${total}`}</span>
                <button type="button" className="btn btn-ghost btn-sm dt-clear" hidden={!hasState} onClick={() => { setFilters({}); setSort(null); setQ(''); }}>Clear filters</button>
                <span className="dt-extra">{toolbarExtra}</span>
            </div>
            <div className="dt-scroll">
                <table>
                    <thead>
                        <tr>
                            {columns.map(c => {
                                const sorted = sort && sort.key === c.key;
                                return (
                                    <th key={c.key} className={c.type === 'number' ? 'num' : ''} aria-sort={sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                                        <div className="th-inner">
                                            {!c.noFilter ? (
                                                <>
                                                    <button type="button" className="th-label" title="Sort" onClick={() => toggleSort(c)}>{c.label}</button>
                                                    <span className="sort-ind">{sorted ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                                                    <button type="button" className={`filter-btn ${filters[c.key] ? 'active' : ''}`} aria-label={`Filter ${c.label}`} title="Filter" onClick={e => openFilter(c, e.currentTarget)}>{FUNNEL}</button>
                                                </>
                                            ) : <span>{c.label}</span>}
                                        </div>
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {!view.length ? (
                            <tr><td colSpan={columns.length} className="empty">{emptyText}</td></tr>
                        ) : view.map((r, i) => {
                            const cls = [onRowClick ? 'clickable' : '', rowClass ? rowClass(r) : ''].filter(Boolean).join(' ');
                            return (
                                <tr key={i} className={cls} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                                    {columns.map(c => {
                                        const v = val(r, c);
                                        return <td key={c.key} className={c.type === 'number' ? 'num' : ''}>{c.render ? c.render(r) : (c.format ? c.format(v) : String(v ?? ''))}</td>;
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                    {showTotals && (
                        <tfoot>
                            <tr>
                                {columns.map((c, i) => c.total
                                    ? <td key={c.key} className="num">{(c.format || fmtNum)(view.reduce((s, r) => s + (Number(val(r, c)) || 0), 0))}</td>
                                    : <td key={c.key}>{i === 0 ? `Total (${view.length})` : ''}</td>)}
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        </>
    );
}

interface FilterPanelProps {
    type: ColumnType;
    current: string;
    existing?: Filter;
    distinct: string[];
    onSort: (dir: 'asc' | 'desc') => void;
    onClear: () => void;
    onApply: (f: Filter | null) => void;
}

function FilterPanel({ type, current, existing, distinct, onSort, onClear, onApply }: FilterPanelProps) {
    const [asc, desc] = SORT_LABELS[type] || SORT_LABELS.text;
    const cmp = existing && existing.type === 'cmp' ? existing : null;
    const range = existing && existing.type === 'range' ? existing : null;
    const set = existing && existing.type === 'set' ? existing : null;
    const [op, setOp] = useState<'eq' | 'gt' | 'lt' | 'between'>(cmp ? cmp.op : 'eq');
    const [a, setA] = useState(cmp ? cmp.a : '');
    const [b, setB] = useState(cmp ? cmp.b ?? '' : '');
    const [from, setFrom] = useState(range ? range.from || '' : '');
    const [to, setTo] = useState(range ? range.to || '' : '');
    const [checked, setChecked] = useState<Set<string>>(() => new Set(distinct.filter(v => !set || set.values.has(v))));
    const [search, setSearch] = useState('');

    let body: ReactNode, read: () => Filter | null, applyDisabled = false;
    if (type === 'number') {
        body = (
            <>
                <div className="pop-field"><label>Show values that are</label>
                    <select value={op} onChange={e => setOp(e.target.value as typeof op)}>
                        <option value="eq">Equal to</option><option value="gt">Greater than</option>
                        <option value="lt">Less than</option><option value="between">Between</option>
                    </select></div>
                <div className="pop-field"><label>{op === 'between' ? 'From' : 'Value'}</label><input type="number" step="any" value={a} onChange={e => setA(e.target.value)} /></div>
                <div className="pop-field" hidden={op !== 'between'}><label>And</label><input type="number" step="any" value={b} onChange={e => setB(e.target.value)} /></div>
            </>
        );
        read = () => (a === '' || (op === 'between' && b === '')) ? null : { type: 'cmp', op, a, b };
    } else if (type === 'date') {
        body = (
            <>
                <div className="pop-field"><label>From</label><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
                <div className="pop-field"><label>To</label><input type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
            </>
        );
        read = () => (!from && !to) ? null : { type: 'range', from, to };
    } else {
        const visible = distinct.filter(v => v.toLowerCase().includes(search.toLowerCase()));
        const allVisibleChecked = visible.length > 0 && visible.every(v => checked.has(v));
        const toggle = (v: string, on: boolean) => setChecked(prev => { const n = new Set(prev); if (on) n.add(v); else n.delete(v); return n; });
        body = (
            <>
                <input type="search" className="pop-search" placeholder="Search" aria-label="Search values" value={search} onChange={e => setSearch(e.target.value)} />
                <div className="pop-list">
                    <label className="pop-check"><input type="checkbox" checked={allVisibleChecked} onChange={e => { const on = e.target.checked; setChecked(prev => { const n = new Set(prev); visible.forEach(v => on ? n.add(v) : n.delete(v)); return n; }); }} /> (Select all)</label>
                    {distinct.map(v => (
                        <label key={v} className="pop-check" hidden={!visible.includes(v)}><input type="checkbox" value={v} checked={checked.has(v)} onChange={e => toggle(v, e.target.checked)} /> {v}</label>
                    ))}
                </div>
            </>
        );
        applyDisabled = checked.size === 0;
        read = () => checked.size === distinct.length ? null : { type: 'set', values: new Set(checked) };
    }
    return (
        <div>
            <button type="button" className={`pop-item ${current === 'asc' ? 'on' : ''}`} onClick={() => onSort('asc')}>{asc}</button>
            <button type="button" className={`pop-item ${current === 'desc' ? 'on' : ''}`} onClick={() => onSort('desc')}>{desc}</button>
            <div className="pop-sep" />
            <div>{body}</div>
            <div className="pop-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>Clear</button>
                <button type="button" className="btn btn-sm" disabled={applyDisabled} onClick={() => onApply(read())}>Apply</button>
            </div>
        </div>
    );
}
