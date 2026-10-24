import { useEffect, useRef, useState } from 'react';
import { num } from '../../domain/engine';
import { SETTINGS } from '../../domain/settings';
import { audit } from '../../domain/enterprise';
import { refresh } from '../../domain/nav';
import { Store } from '../../domain/store';
import { logOut } from './Topbar';
import { USE_API } from '../../api/client';
import { recheckIdentity } from '../../api/auth';

/** Screen lock after inactivity (Administration › Security and data). */
export function IdleLock() {
    const [locked, setLocked] = useState(false);
    const lastActive = useRef(Date.now());
    useEffect(() => {
        const touch = () => { lastActive.current = Date.now(); };
        const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'] as const;
        events.forEach(e => document.addEventListener(e, touch, { passive: true }));
        const timer = setInterval(() => {
            const mins = num((SETTINGS.retention || { idleMinutes: 30 }).idleMinutes ?? 30);
            if (!mins) return;
            if (Date.now() - lastActive.current > mins * 60000) {
                setLocked(prev => { if (!prev) audit('session.lock', 'Screen locked after inactivity'); return true; });
            }
        }, 30000);
        return () => { events.forEach(e => document.removeEventListener(e, touch)); clearInterval(timer); };
    }, []);
    if (!locked) return null;
    const mins = num((SETTINGS.retention || { idleMinutes: 30 }).idleMinutes ?? 30);
    return (
        <div id="lock" className="modal active" style={{ background: 'var(--bg)' }}>
            <div className="card pad" style={{ maxWidth: '380px', textAlign: 'center' }}>
                <h2>Screen locked</h2>
                <p className="note" style={{ margin: '8px 0 16px' }}>Locked after {mins} minutes without activity, so figures are not left visible.</p>
                <div className="btn-row" style={{ justifyContent: 'center' }}>
                    <button className="btn" id="unlock" onClick={() => { setLocked(false); lastActive.current = Date.now(); if (USE_API) void recheckIdentity(); refresh(); }}>Continue as {Store.actorName()}</button>
                    <button className="btn btn-ghost" onClick={() => { setLocked(false); void logOut(); }}>Log out</button>
                </div>
            </div>
        </div>
    );
}
