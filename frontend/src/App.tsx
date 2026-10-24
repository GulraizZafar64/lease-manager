import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppState } from './hooks/useAppState';
import { useTabTransitions } from './hooks/useTabTransitions';
import { current, startRouting, takeScrollToTop } from './domain/nav';
import { initTheme, startApp } from './domain/startup';
import { LOGIN_PATH, afterLoginUrl, getSession, markSessionRecorded, signOut, toLoginUrl } from './domain/session';
import { REGISTRY, companyById, isCompanyActive } from './domain/platform';
import { Ent, audit, roleLabel } from './domain/enterprise';
import { Store } from './domain/store';
import { LoginPage } from './pages/LoginPage';
import { ApiLoginPage } from './pages/ApiLoginPage';
import { ApiError, USE_API, onSessionEnded } from './api/client';
import { fullySignedIn, loadIdentity, watchSession, type Me } from './api/auth';
import { Sidebar } from './components/layout/Sidebar';
import { Topbar } from './components/layout/Topbar';
import { IdleLock } from './components/layout/IdleLock';
import { ScreenErrorBoundary } from './components/layout/ScreenErrorBoundary';
import { ModalHost, PopoverHost, ToastHost, useEscapeToClose } from './components/common/Hosts';
import { Screen, screenMeta } from './pages/registry';

/** End the session and show the login page with the reason. */
function leave(reason: string): void {
    signOut();
    window.location.replace(LOGIN_PATH() + '?reason=' + reason);
}

/** The login page's notice for a session the server ended. */
const REASON: Record<string, string> = { session_expired: 'expired', account_disabled: 'disabled', company_inactive: 'inactive', unauthenticated: 'ended' };

/** Signed in through the API: the server says who is signed in; the app opens once it has. */
async function startWithServer(onReady: () => void, onError: (message: string) => void): Promise<void> {
    let me: Me;
    try { me = await loadIdentity(); }
    catch (e) {
        const code = e instanceof ApiError ? e.code : '';
        if (code === 'network') { onError((e as ApiError).message); return; }
        leave(REASON[code] || 'ended'); // the login page resumes a half-finished sign-in
        return;
    }
    const s = getSession();
    // The browser's record must match the server's session; otherwise sign in again here
    if (!fullySignedIn(me) || !s || s.userId !== me.user.id || s.companyId !== me.company.id) { signOut(); toLoginUrl(); return; }
    try { await startApp(); }
    catch (e) { onError(e instanceof ApiError ? `Could not load your company’s settings: ${e.message}` : 'Could not load your company’s settings.'); return; }
    onReady();
    if (!s.recorded) { audit('session.signin', `Signed in as ${roleLabel(me.user.role)}`); markSessionRecorded(); }
    startRouting();
}

export default function App() {
    const version = useAppState();
    const [ready, setReady] = useState(false);
    const [startError, setStartError] = useState('');
    useEscapeToClose();
    useTabTransitions(version);

    const readyRef = useRef(false);
    const session = getSession();

    // Inside the Claude viewer people are already signed in with their Claude account.
    const loginRequired = !(ready && Store.mode === 'db');

    useEffect(() => {
        initTheme();
        if (USE_API) {
            if (getSession()) void startWithServer(() => { readyRef.current = true; setReady(true); }, setStartError);
            else toLoginUrl();
            return;
        }
        const s0 = getSession();
        if (!s0) toLoginUrl();
        else if (!companyById(s0.companyId)) { leave('company'); return; }
        else if (!isCompanyActive(companyById(s0.companyId))) { leave('inactive'); return; }
        startApp().then(() => {
            readyRef.current = true; setReady(true);
            if (Store.mode === 'db') { startRouting(); return; }
            const s = getSession();
            if (!s) return;
            // The account may have been disabled or deleted since this browser signed in.
            const u = Ent.users.get(s.userId);
            if (!u || u.status !== 'active') { leave(u ? 'disabled' : 'missing'); return; }
            if (!s.recorded) {
                void Ent.users.save({ ...u, lastLoginAt: new Date().toISOString() });
                audit('session.signin', `Signed in as ${roleLabel(u.role)}`);
                markSessionRecorded();
            }
            startRouting();
        });
    }, []);
    // Signed in through the API: a session the server ends (timeout, disabled, company inactive) returns to the login page.
    useEffect(() => {
        if (!USE_API || !ready) return;
        const stopWatch = watchSession();
        const stopListen = onSessionEnded(e => leave(REASON[e.code] || 'ended'));
        // Other people's changes (leases, bank statements, batches, ERP files, drafts): read again on returning to the tab (at most every 30 seconds)
        let last = Date.now();
        const onVisible = () => { if (document.visibilityState === 'visible' && Date.now() - last > 30000) { last = Date.now(); void Store.refresh(); void Ent.bank.refresh(); void Ent.batches.refresh(); void Ent.exports.refresh(); void Ent.drafts.refresh(); } };
        document.addEventListener('visibilitychange', onVisible);
        return () => { stopWatch(); stopListen(); document.removeEventListener('visibilitychange', onVisible); };
    }, [ready]);
    // The platform owner may deactivate or remove the company while it is open in another tab.
    useEffect(() => {
        if (USE_API) return;
        const onStorage = (e: StorageEvent) => {
            const s = getSession();
            if (e.key !== REGISTRY || !s) return;
            const c = companyById(s.companyId);
            if (!c) leave('company'); else if (!isCompanyActive(c)) leave('inactive');
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);
    // Signed out (or Back to a page after signing out): keep the address bar on the login page.
    useEffect(() => { if (!session && loginRequired) toLoginUrl(); });

    // Each company's data is loaded at start-up, so entering a company reloads the app.
    const onSignedIn = () => window.location.replace(afterLoginUrl());

    const cur = current();
    const meta = cur ? screenMeta(cur) : { title: 'Overview', crumb: '' };

    useEffect(() => { if (cur && (session || !loginRequired)) document.title = meta.title + ' | IFRS 16 Lease Manager'; });
    useLayoutEffect(() => { if (takeScrollToTop()) window.scrollTo(0, 0); }, [version]);

    if (!session && loginRequired) return <>{USE_API ? <ApiLoginPage onSignedIn={onSignedIn} /> : <LoginPage onSignedIn={onSignedIn} />}<ToastHost /></>;

    return (
        <>
            <div className="app">
                <Sidebar />
                <main className="main">
                    <Topbar title={meta.title} ready={ready} />
                    {!ready && !startError && <div id="loading" className="note"><span className="spinner"></span> Loading leases…</div>}
                    {startError && <div className="note" role="alert">{startError} <button type="button" className="link-btn" onClick={() => window.location.reload()}>Try again</button></div>}
                    {ready && cur && (
                        <div className="screen active" id={cur.screen} key={cur.key}>
                            <ScreenErrorBoundary key={cur.key}>
                                <Screen item={cur} />
                            </ScreenErrorBoundary>
                        </div>
                    )}
                </main>
            </div>
            <ModalHost />
            <ToastHost />
            <PopoverHost />
            <IdleLock />
        </>
    );
}
