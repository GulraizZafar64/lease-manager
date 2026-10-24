import { useSyncExternalStore } from 'react';
import { getVersion, subscribe } from '../domain/state';

/** Re-render when any app data changes (leases, settings, navigation, users...). Returns a change counter. */
export function useAppState(): number {
    return useSyncExternalStore(subscribe, getVersion);
}
