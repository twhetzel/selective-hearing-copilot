/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of `server/gcp-stt-proxy.mjs`, e.g. ws://192.168.1.10:8787 */
  readonly VITE_GCP_STT_WS_URL?: string
  /** Must match glasses PCM (often 16000). */
  readonly VITE_STT_SAMPLE_RATE_HZ?: string
  readonly VITE_STT_LANGUAGE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
