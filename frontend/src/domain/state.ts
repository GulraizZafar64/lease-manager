/* App-wide change notification. Domain objects (Store, SETTINGS, Ent, navigation)
   are plain modules; every mutation calls notify() and the React tree re-renders
   through useAppState(). */
import { todayISO } from '../utils/dates';

let version = 0;
const listeners = new Set<() => void>();

export function notify(): void {
    version++;
    listeners.forEach(l => l());
}
export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export const getVersion = (): number => version;

/** Balances date chosen in the top bar ("Balances at"). */
export let AS_OF = todayISO();
export function setAsOf(date: string): void {
    AS_OF = date;
    notify();
}

/** Entity filter chosen in the top bar. */
export const SCOPE = { entity: '' };
export function setScopeEntity(entity: string): void {
    SCOPE.entity = entity;
    notify();
}
