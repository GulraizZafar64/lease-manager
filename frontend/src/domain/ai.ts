/* ======================================================================
   AI (Claude)
   Inside the Claude viewer: the page's sample capability, which spends the
   viewer's own Claude usage and asks permission the first time. With the
   company server: the server's AI (aiServer.ts), within the company's
   monthly allowance. Otherwise there is no AI and the features say so.
   Every call is made on an explicit click.
   ====================================================================== */
import { balanceAt } from './engine';
import { leaseEnd, measurementType, statusOf } from './lease';
import { AS_OF } from './state';
import { audit, can } from './enterprise';
import { toast } from '../utils/uiStore';
import { errCode } from '../utils/format';
import type { EngineResult } from '../types/engine';
import type { Lease } from '../types/lease';
import { ApiError, USE_API } from '../api/client';
import { aiStatus, serverSample } from './aiServer';

let rawSample: SampleCapability | null | undefined;
async function getRawSample(): Promise<SampleCapability | null> {
    if (rawSample !== undefined) return rawSample;
    if (window.claude && window.claude.use) rawSample = await window.claude.use('sample').catch(() => null);
    else if (USE_API) {
        try { rawSample = (await aiStatus()).available ? serverSample() : null; }
        catch { return null; } // not signed in yet, or the server is unreachable: ask again next time
    } else rawSample = null;
    return rawSample;
}
/** Whether the AI capability exists in this view, without the permission check. */
export const aiAvailable = async (): Promise<boolean> => !!(await getRawSample());

/** The AI capability, permission-checked and with every request recorded in the audit log. */
export async function getSample(): Promise<SampleCapability | null> {
    const s = await getRawSample();
    if (!s) return s;
    if (!can('ai.use')) { toast('Your role cannot use AI features.'); return null; }
    const brief = (i: string | SampleMessage[]) => (typeof i === 'string' ? i : (i[i.length - 1] || { content: '' }).content || '').replace(/\s+/g, ' ').slice(0, 160);
    const w = ((i: string | SampleMessage[], o?: SampleOptions) => { audit('ai', `AI request: ${brief(i)}`); return s(i, o); }) as SampleCapability;
    w.json = (i, o) => { audit('ai', `AI request (structured): ${brief(i)}`); return s.json(i, o); };
    w.limits = () => s.limits();
    return w;
}

export const AI_ERR: Record<string, string> = { not_granted: 'AI was not allowed for this page. Allow it from the page’s permissions to use AI features.', rate_limited: 'Too many AI requests at once. Wait a moment and try again.', prompt_too_large: 'The document is too long for one request. Paste the key clauses instead.', invalid_json: 'The AI reply could not be read. Try again.', refused: 'The AI declined this request.', cancelled: 'Stopped.', session_expired: 'Your session expired. Reload the page.', sampling_disabled: 'AI is turned off for this account.', images_unavailable: 'Image reading is not available here. Paste the text instead.' };
export const aiErr = (e: unknown): string => AI_ERR[errCode(e) || ''] || (e instanceof ApiError && e.message) || 'The AI request failed. Try again.';

/** The facts about a lease that AI prompts and advisor tools receive. */
export function leaseContext(l: Lease, res: EngineResult | null) {
    const b = res ? balanceAt(res, AS_OF) : { L: 0, A: 0 };
    return {
        id: l.id, name: l.name, role: l.role, status: statusOf(l, AS_OF), counterparty: l.counterparty, assetClass: l.assetClass, area: l.area ? `${l.area} ${l.areaUnit}` : null, currency: l.currency,
        terms: l.terms, measurement: measurementType(l), leaseTermMonths: res ? res.termMonths : null, leaseEndDate: leaseEnd(l),
        balancesAtToday: res ? { liabilityOrNetInvestment: Math.round(b.L || 0), rightOfUseAsset: Math.round(b.A || 0) } : null,
        initial: res ? Object.fromEntries(Object.entries(res.initial).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v])) : null,
        events: (l.events || []).map(e => ({ type: e.type, effective: e.effective, status: e.status, newRate: e.newRate, newPayment: e.newPayment, reason: e.reason })),
    };
}
