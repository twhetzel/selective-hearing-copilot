import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // Required so a phone on the same Wi‑Fi can load the Vite dev server (QR / sideload).
    host: true,
  },
})
