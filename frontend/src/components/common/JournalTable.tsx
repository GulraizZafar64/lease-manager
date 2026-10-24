import { Fragment } from 'react';
import { fmtNum } from '../../utils/format';
import { fmtDate } from '../../utils/dates';
import type { Journal } from '../../domain/journals';

/** Journal entries as a ledger: one header row per entry, then its debit and credit lines. */
export function JournalTable({ list, showLease = true }: { list: Journal[]; showLease?: boolean }) {
    if (!list.length) return <p className="empty">No journal entries in this period.</p>;
    return (
        <div className="scroll-x" style={{ maxHeight: '62vh' }}>
            <table>
                <thead><tr><th>Date</th>{showLease && <th>Lease</th>}<th>Description / account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
                <tbody>
                    {list.map((j, n) => (
                        <Fragment key={n}>
                            <tr className="sub"><td>{fmtDate(j.date)}</td>{showLease && <td>{j.leaseId}</td>}<td className="wrap">{j.memo}</td><td></td><td></td></tr>
                            {j.lines.map((x, i) => (
                                <tr key={i}><td></td>{showLease && <td></td>}<td style={{ paddingLeft: `${x.cr ? 34 : 14}px` }}>{x.account}</td><td className="num">{x.dr ? fmtNum(x.dr) : ''}</td><td className="num">{x.cr ? fmtNum(x.cr) : ''}</td></tr>
                            ))}
                        </Fragment>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** Dr / Cr preview lines used in measurement panels and event impact (the `.je` table). */
export function JournalPreview({ lines }: { lines: [account: string, dr: number, cr: number][] }) {
    return (
        <table className="je">
            <tbody>
                {lines.filter(x => Math.abs(x[1]) > 0.004 || Math.abs(x[2]) > 0.004).map(([a, d, c], i) => (
                    <tr key={i}><td className={c ? 'cr' : ''}>{c ? '' : 'Dr '}{c ? 'Cr ' : ''}{a}</td><td className="num">{d ? fmtNum(d) : ''}</td><td className="num">{c ? fmtNum(c) : ''}</td></tr>
                ))}
            </tbody>
        </table>
    );
}
