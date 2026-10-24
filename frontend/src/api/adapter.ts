/* A collection the server holds (VITE_USE_API=true): read everything, send the change from what the server
   holds as the actions it stands for, delete. Used by Ent's collections in domain/enterprise.ts. */
import { ApiError } from './client';

export interface ServerAdapter<T> {
    load(): Promise<T[]>;
    save(before: T | undefined, after: T): Promise<void>;
    remove(id: string): Promise<void>;
}
/** Someone without the permission to read a collection sees none of it, as the screens expect. */
export const orNone = async <T>(p: Promise<T[]>): Promise<T[]> => { try { return await p; } catch (e) { if (e instanceof ApiError && e.status === 403) return []; throw e; } };
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
