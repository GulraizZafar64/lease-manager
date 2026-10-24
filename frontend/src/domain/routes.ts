/* URL routing: each screen has its own path, and its simple view state
   (tab, period, filters) goes in the query string, so the address bar follows
   navigation, reload keeps the screen and links can be shared. Params that are
   not plain values (a prefilled lease, a pasted contract) live only in the
   browser history entry. */
import type { ScreenId, ScreenParamMap } from './nav';
import { Store } from './store';

export interface Route { screen: ScreenId; params: ScreenParamMap[ScreenId] }

const PATHS: Record<Exclude<ScreenId, 'detail' | 'entry'>, string> = {
    dashboard: '',
    register: 'register',
    import: 'import',
    payments: 'payments',
    approvals: 'approvals',
    journals: 'journals',
    reports: 'reports',
    ai: 'ai-advisor',
    guidance: 'guidance',
    tools: 'calculators',
    validation: 'validation',
    settings: 'settings',
    bank: 'bank-reconciliation',
    batches: 'payment-batches',
    erp: 'erp-export',
    analytics: 'analytics',
    admin: 'administration',
    users: 'users',
    roles: 'roles',
};
const SCREEN_OF_PATH = new Map(Object.entries(PATHS).map(([s, p]) => [p, s as ScreenId]));

/** Query params that are not strings. */
const NUMBERS = new Set(['months', 'v']);
const BOOLEANS = new Set(['fresh', 'skipDup', 'fx']);

const base = (): string => import.meta.env.BASE_URL.replace(/\/$/, '');

export function routeToUrl({ screen, params }: Route): string {
    const q = new URLSearchParams();
    let path: string;
    const rest: Record<string, unknown> = { ...params };
    if (screen === 'detail') { path = 'leases/' + encodeURIComponent(String(rest.id)); delete rest.id; }
    else if (screen === 'entry') {
        path = rest.mode === 'edit' && rest.id ? `leases/${encodeURIComponent(String(rest.id))}/edit` : 'leases/new';
        delete rest.mode; delete rest.id;
    }
    else path = PATHS[screen];
    Object.entries(rest).forEach(([k, v]) => {
        if (v === null || v === undefined || v === '' || v === false && !BOOLEANS.has(k)) return;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') q.set(k, String(v));
    });
    const qs = q.toString();
    return `${base()}/${path}${qs ? '?' + qs : ''}`;
}

/** The trail to show for the current address; unknown paths and leases fall back to a sensible screen. */
export function trailFromLocation(): Route[] {
    let path = window.location.pathname;
    if (path.startsWith(base())) path = path.slice(base().length);
    path = path.replace(/^\/+|\/+$/g, '');
    const params: Record<string, string | number | boolean> = {};
    new URLSearchParams(window.location.search).forEach((v, k) => {
        params[k] = NUMBERS.has(k) && v !== '' && !isNaN(Number(v)) ? Number(v) : BOOLEANS.has(k) ? v === 'true' : v;
    });
    const register: Route = { screen: 'register', params: {} };
    const lease = path.match(/^leases\/([^/]+)(\/edit)?$/);
    if (path === 'leases/new') return [{ screen: 'entry', params: { ...params, mode: 'new' } as ScreenParamMap['entry'] }];
    if (lease) {
        const id = decodeURIComponent(lease[1]);
        if (!Store.get(id)) return [register];
        const detail: Route = { screen: 'detail', params: { ...(lease[2] ? {} : params), id } as ScreenParamMap['detail'] };
        return lease[2] ? [register, detail, { screen: 'entry', params: { ...params, mode: 'edit', id } as ScreenParamMap['entry'] }] : [register, detail];
    }
    const screen = SCREEN_OF_PATH.get(path);
    return [screen ? { screen, params: params as ScreenParamMap[ScreenId] } : { screen: 'dashboard', params: {} }];
}
