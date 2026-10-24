/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" to use the backend API; otherwise the app keeps its data in the browser. */
  readonly VITE_USE_API?: string;
  /** Where the dev server forwards /api (default http://127.0.0.1:8090). */
  readonly VITE_API_TARGET?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
