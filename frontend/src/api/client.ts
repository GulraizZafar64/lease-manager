/* HTTP client for the backend API (../backend, all routes under /api).
   - Same origin: the dev server forwards /api, so the HttpOnly session cookie just works.
   - Every request carries the header the server requires on changes (anti-forgery).
   - Errors become ApiError with the server's code and a message fit to show people. */

/** Whether the app uses the backend API (VITE_USE_API=true) or keeps data in the browser. */
export const USE_API = import.meta.env.VITE_USE_API === 'true';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '') + '/api';
const HEADERS = { 'x-requested-with': 'lease-manager' };

/** Error codes the server returns (lease-manager/src), plus 'network' when it cannot be reached. */
export type ApiErrorCode =
    | 'network' | 'unauthenticated' | 'session_expired' | 'account_disabled' | 'company_inactive' | 'mfa_required' | 'password_change_required' | 'forbidden' | 'csrf'
    | 'bad_credentials' | 'bad_code' | 'validation' | 'not_found' | 'duplicate' | 'bad_state' | 'locked'
    | 'period_locked' | 'fx_missing' | 'last_superadmin' | 'internal' | (string & Record<never, never>);

export class ApiError extends Error {
    constructor(readonly status: number, readonly code: ApiErrorCode, message: string) { super(message); this.name = 'ApiError'; }
}

/** 401 codes meaning there is no session any more, and why. */
export const SESSION_ENDED = new Set<string>(['unauthenticated', 'session_expired', 'account_disabled', 'company_inactive']);

type Listener = (e: ApiError) => void;
const sessionListeners: Listener[] = [];
/** Called when the server says the session has ended (signed out, expired, user disabled or company inactive). */
export function onSessionEnded(f: Listener): () => void {
    sessionListeners.push(f);
    return () => { const i = sessionListeners.indexOf(f); if (i >= 0) sessionListeners.splice(i, 1); };
}

const GENERIC: Record<number, string> = {
    400: 'The request was not valid.', 401: 'Sign in to continue.', 403: 'Your role does not allow this.',
    404: 'Not found.', 409: 'This conflicts with the current state. Refresh and try again.', 500: 'Something went wrong on the server.',
};

async function request<T>(method: string, path: string, body?: unknown, opts: { quiet401?: boolean } = {}): Promise<T> {
    let res: Response;
    try {
        res = await fetch(BASE + path, {
            method,
            credentials: 'same-origin',
            headers: body === undefined ? HEADERS : { ...HEADERS, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and that the API is running.');
    }
    const text = await res.text();
    let data: unknown = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (res.ok) return data as T;
    const d = (data || {}) as { error?: string; message?: string };
    const err = new ApiError(res.status, d.error || 'error', d.message || GENERIC[res.status] || `Request failed (${res.status}).`);
    if (res.status === 401 && SESSION_ENDED.has(err.code) && !opts.quiet401) sessionListeners.forEach(f => f(err));
    return Promise.reject(err);
}

export const api = {
    get: <T>(path: string, opts?: { quiet401?: boolean }) => request<T>('GET', path, undefined, opts),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    del: <T>(path: string) => request<T>('DELETE', path),
};

export interface Health { status: 'ok'; engineValidation: string; time: string }
export const health = (): Promise<Health> => api.get<Health>('/health');
