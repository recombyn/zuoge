/// <reference types="vite/client" />

declare module 'virtual:svg-icons-register';

declare const __GOOGLE_CLIENT_ID__: string;
declare const __DOCS_URL__: string;
declare const __DESKTOP_MODE__: string;
declare const __API_BASE_URL__: string;

interface ImportMetaEnv {
  readonly VITE_DESKTOP_MODE?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DOCS_URL?: string;
  readonly VITE_COLLAB_ENABLED?: string;
  readonly TAURI_ENV_PLATFORM?: string;
}
