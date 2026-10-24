import { useMemo } from 'react';
import type { ScreenProps } from './registry';
import { SETTINGS } from '../domain/settings';
import { runValidation } from '../domain/validation';
import { KB_ERRATA } from '../domain/guidance';
import { useAppState } from '../hooks/useAppState';
import { StmtList } from './GuidancePage';
import { fmtNum, sum } from '../utils/format';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ValidationPage(_props: ScreenProps<'validation'>) {
    const version = useAppState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const results = useMemo(() => runValidation(), [version]);
    const pass = results.filter(r => r.pass).length, checks = sum(results, r => r.rows.length), cpass = sum(results, r => r.rows.filter(x => x.pass).length);
    return (
        <>
            <div className={`banner ${pass === results.length ? 'ok' : 'bad'}`}><div><strong>{`${pass} of ${results.length} worked examples reproduced (${cpass} of ${checks} figures)`}</strong><p>{`Each case is run through the same engine that measures your leases, using the effective-rate convention of the IASB examples. Tolerance is the rounding in the published answer. ${SETTINGS.rateConvention === 'nominal' ? 'Your portfolio uses the nominal convention, which matches these examples whenever payments are annual.' : ''}`}</p></div></div>
            {results.map(r => (
                <div key={r.id} className="card" style={{ marginBottom: '12px' }}>
                    <div className="section-head"><div><h3>{r.id}: {r.title}</h3><p className="note">{r.source}</p></div><span className={r.pass ? 'pass' : 'fail'}>{r.pass ? 'Matches' : 'Differs'}</span></div>
                    <div className="scroll-x">
                        <table>
                            <thead><tr><th>Figure</th><th className="num">Published</th><th className="num">Engine</th><th className="num">Difference</th><th></th></tr></thead>
                            <tbody>{r.rows.map((x, i) => <tr key={i}><td>{x.label}</td><td className="num">{fmtNum(x.exp, x.exp % 1 ? 2 : 0)}</td><td className="num">{fmtNum(x.got, x.exp % 1 ? 2 : 0)}</td><td className="num">{fmtNum(x.got - x.exp, 2)}</td><td className={x.pass ? 'pass' : 'fail'}>{x.pass ? '✓' : '✗'}</td></tr>)}</tbody>
                        </table>
                    </div>
                </div>
            ))}
            <div className="card pad"><h3>Not reproduced, by design</h3><StmtList rows={KB_ERRATA.slice(0, 2).concat([KB_ERRATA[5]])} /><p className="note" style={{ marginTop: '8px' }}>These answers contain errors, so matching them would mean copying the error. See Guidance, “Review of your uploaded examples”.</p></div>
        </>
    );
}
