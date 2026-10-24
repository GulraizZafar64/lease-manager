import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ScreenProps } from './registry';
import { KB, KB_ERRATA, kbSearch } from '../domain/guidance';
import { go, setParams } from '../domain/nav';

/** Two-column table of [source, issue] rows (the original's stmtList). */
export function StmtList({ rows }: { rows: [string, string][] }) {
    return (
        <div className="scroll-x">
            <table>
                <thead><tr><th>Source</th><th>Issue</th></tr></thead>
                <tbody>{rows.map(([a, b], i) => <tr key={i}><td>{a}</td><td className="wrap">{b}</td></tr>)}</tbody>
            </table>
        </div>
    );
}

const ASK_HTML = '\n        <div class="btn-row" style="margin-top:16px"><button class="btn btn-ghost" id="kb-ask">Ask the advisor about this</button></div>';

export function GuidancePage({ params: p }: ScreenProps<'guidance'>) {
    const [text, setText] = useState(p.q || '');
    const timer = useRef<number | undefined>(undefined);
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => () => window.clearTimeout(timer.current), []);

    const q = p.q || '';
    const list = q ? kbSearch(q) : KB;
    const cur = KB.find(t => t.id === p.topic) || list[0] || KB[0];
    const groups = [...new Set(list.map(t => t.group))];
    const errata = p.topic === 'errata';

    const onInput = (v: string) => {
        setText(v);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
            setParams<'guidance'>({ q: v });
            const x = input.current; if (x) { x.focus(); x.setSelectionRange(x.value.length, x.value.length); }
        }, 250);
    };
    const onBodyClick = (e: MouseEvent<HTMLDivElement>) => { if ((e.target as Element).closest('#kb-ask')) go('ai', {}, { reset: true }); };

    return (
        <div className="kb">
            <div className="card">
                <div className="pad" style={{ paddingBottom: '8px' }}><input type="search" id="kb-q" placeholder="Search, e.g. lock-in, deposit, KIBOR" value={text} ref={input} onChange={e => onInput(e.target.value)} /></div>
                <div className="kb-list">
                    {groups.length ? groups.map(g => [
                        <div key={'g:' + g} className="note" style={{ padding: '8px 14px 4px' }}>{g}</div>,
                        ...list.filter(t => t.group === g).map(t => <button key={t.id} className={`kb-item ${t.id === cur.id ? 'active' : ''}`} data-t={t.id} onClick={() => setParams<'guidance'>({ topic: t.id })}>{t.title}<small>{t.refs}</small></button>),
                    ]) : <p className="empty">No topics match.</p>}
                    <div className="note" style={{ padding: '8px 14px 4px' }}>Reference</div><button className={`kb-item ${errata ? 'active' : ''}`} data-t="errata" onClick={() => setParams<'guidance'>({ topic: 'errata' })}>Review of your uploaded examples<small>Errors and IAS 17 carry-overs found</small></button>
                </div>
            </div>
            <div className="card">
                <div className="section-head"><h2>{errata ? 'Review of the uploaded examples' : cur.title}</h2>{errata ? null : <span className="ref">IFRS {cur.refs}</span>}</div>
                {errata ? (
                    <div key="errata" className="pad kb-body"><p>The worked examples you supplied were used to test the calculation engine (see Validation). These points in them are wrong or out of date under IFRS 16:</p><StmtList rows={KB_ERRATA} />
                        {'\n        '}</div>
                ) : (
                    <div key={'t:' + cur.id} className="pad kb-body" onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: cur.body + ASK_HTML }} />
                )}
            </div>
        </div>
    );
}
