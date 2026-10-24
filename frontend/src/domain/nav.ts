/* Navigation: a breadcrumb trail of screens, each with its own params. Screens
   keep view state (selected tab, period, filters) in their params, so going back
   through the breadcrumb returns to the same view, as in the original page. */
import { notify } from './state';
import { popover } from '../utils/uiStore';
import type { Lease } from '../types/lease';
import { routeToUrl, trailFromLocation, type Route } from './routes';

export interface ScreenParamMap {
    dashboard: Record<string, never>;
    register: { preset?: string };
    detail: { id: string; tab?: string; highlight?: string; focus?: string | null; by?: string };
    entry: { mode: 'new' | 'edit'; id?: string; prefill?: Lease; tab?: string };
    import: { attachTo?: string; fresh?: boolean };
    payments: { window?: 'open' | 'month' | 'all' };
    approvals: Record<string, never>;
    journals: { from?: string; to?: string; view?: 'summary' | 'detail' };
    reports: { report?: string; from?: string; to?: string; draft?: string | null };
    ai: { leaseId?: string; contract?: { name: string; text: string }; ask?: string | null };
    guidance: { q?: string; topic?: string };
    tools: { calc?: string };
    validation: Record<string, never>;
    settings: Record<string, never>;
    bank: { id?: string | null };
    batches: { id?: string | null };
    erp: { from?: string; to?: string; target?: string; skipDup?: boolean; fx?: boolean };
    analytics: { tab?: string; months?: number; sc?: string; v?: number | string };
    admin: { tab?: string };
    users: { q?: string; role?: string; status?: string };
    roles: { id?: string; view?: 'edit' | 'compare' };
}
export type ScreenId = keyof ScreenParamMap;
export interface TrailItem<S extends ScreenId = ScreenId> { screen: S; params: ScreenParamMap[S]; /** Unique per visit; a new visit mounts the screen afresh. */ key: number }

let trail: TrailItem[] = [];
let visits = 0;
let scrollToTop = false;

export const getTrail = (): readonly TrailItem[] => trail;
export const current = (): TrailItem | undefined => trail[trail.length - 1];

interface HistoryState { trail: Route[] }

/** Mirror the trail into the address bar and browser history. */
function record(mode: 'push' | 'replace'): void {
    const cur = current();
    if (!cur) return;
    const state: HistoryState = { trail: trail.map(({ screen, params }) => ({ screen, params })) };
    const url = routeToUrl(cur);
    if (mode === 'push' && url === window.location.pathname + window.location.search) mode = 'replace';
    try { window.history[mode === 'push' ? 'pushState' : 'replaceState'](state, '', url); }
    catch { window.history[mode === 'push' ? 'pushState' : 'replaceState']({ trail: [] }, '', url); }
}

function show(keepScroll = false, history: 'push' | 'replace' | 'none' = 'push'): void {
    popover.close();
    if (history !== 'none') record(history);
    if (!keepScroll) scrollToTop = true;
    notify();
}

const restore = (routes: Route[]): void => { trail = routes.map(r => ({ ...r, key: ++visits }) as TrailItem); };

/** Open the screen named by the address bar, and follow the browser's Back and Forward buttons. */
let routing = false;
export function startRouting(): void {
    restore(trailFromLocation());
    show(false, 'replace');
    if (routing) return;
    routing = true;
    window.addEventListener('popstate', e => {
        const st = e.state as HistoryState | null;
        restore(st && st.trail && st.trail.length ? st.trail : trailFromLocation());
        show(false, 'none');
    });
}

export function go<S extends ScreenId>(screen: S, params: ScreenParamMap[S] = {} as ScreenParamMap[S], opts: { reset?: boolean; replace?: boolean } = {}): void {
    if (opts.reset) trail = [];
    if (opts.replace && trail.length) trail = trail.slice(0, -1);
    trail = trail.concat([{ screen, params, key: ++visits } as TrailItem]);
    show(false, opts.replace ? 'replace' : 'push');
}
export function goBack(): void {
    if (trail.length > 1) { trail = trail.slice(0, -1); trail[trail.length - 1] = { ...trail[trail.length - 1], key: ++visits }; show(); }
    else go('register', {}, { reset: true });
}
/** Return to the breadcrumb at index i. */
export function goToCrumb(i: number): void {
    trail = trail.slice(0, i + 1);
    trail[i] = { ...trail[i], key: ++visits };
    show();
}
/** Update the current screen's params (view state) and re-render without scrolling. */
export function setParams<S extends ScreenId>(patch: Partial<ScreenParamMap[S]>): void {
    const cur = current();
    if (!cur) return;
    Object.assign(cur.params, patch);
    show(true, 'replace');
}
/** Re-render the current screen in place (the original page's refresh()). */
export function refresh(): void { show(true, 'none'); }

/** Read once after a render: true when the last navigation should scroll to the top. */
export function takeScrollToTop(): boolean { const s = scrollToTop; scrollToTop = false; return s; }
