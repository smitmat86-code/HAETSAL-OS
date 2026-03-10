/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FEATURE_GOOGLE?: string
  readonly VITE_FEATURE_BOOTSTRAP?: string
  readonly VITE_WORKER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
