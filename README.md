# selective-hearing-copilot

Accessibility-oriented cues for **Even G2** using [`@evenrealities/even_hub_sdk`](https://www.npmjs.com/package/@evenrealities/even_hub_sdk). The UI runs in the **Even Realities** app WebView on a phone paired with the glasses; the in-browser “HUD preview” is for local development only.

## Setup

```bash
npm install
```

This repo uses `.npmrc` with `legacy-peer-deps` so `@evenrealities/evenhub-cli` installs cleanly alongside TypeScript 6.

## Develop on your laptop

```bash
npm run dev
```

`npm run dev` runs `vite --host` and `vite.config.ts` sets `server.host: true` so a phone on the same network can load the app by IP, not only `localhost`. Check the **Network** line in the dev terminal for the exact URL to use in the QR.

## Test on the glasses (QR sideload)

1. Keep **`npm run dev`** running.
2. Find your Mac’s **Wi‑Fi IP** (the address phones on the same network use to reach this machine), for example:

   ```bash
   ipconfig getifaddr en0
   ```

   (Use `en1` if `en0` is empty. You can also use **System Settings → Network → Wi‑Fi → Details → TCP/IP**.)

3. Generate a QR code that encodes the dev server URL (default Vite port is **5173**):

   ```bash
   npm run qr -- --url "http://YOUR_LAN_IP:5173"
   ```

   Or build the URL from parts:

   ```bash
   npm run qr -- -i YOUR_LAN_IP -p 5173
   ```

   Equivalent without the npm script:

   ```bash
   npx evenhub qr --url "http://YOUR_LAN_IP:5173"
   ```

4. **Scan the QR** with the **Even Realities** app on the phone (same Wi‑Fi as the laptop). The app loads in the WebView and can talk to the glasses via the bridge.

**Notes**

- The phone and laptop should be on the **same network**; guest Wi‑Fi often blocks device-to-device access.
- If the phone cannot connect, check **macOS Firewall** and that nothing else is blocking port **5173**.

## Troubleshooting: phone does not open the page

Work through these in order; if step 1 fails, the QR / Even app is not the problem yet.

1. **Dev server is running** — With `npm run dev`, the terminal should show a **Network** URL (e.g. `http://192.168.2.29:5173/`). If you only see `localhost`, the server is not bound to the LAN; this repo uses `vite --host` and `server.host: true` so you should see **Network** after starting dev.

2. **Use a fresh IP in the URL** — Your Wi‑Fi IP **changes** when you switch networks (e.g. hotspot → home). Run `ipconfig getifaddr en0` again on the Mac. If that returns nothing, try `en1`, or use **System Settings → Network → Wi‑Fi → Details → TCP/IP** and use the **IPv4** address shown there. **Regenerate the QR** after the IP changes.

3. **Test in the phone’s browser first** — On the phone, open **Safari** (or Chrome) and go to `http://YOUR_LAN_IP:5173` (same address as the QR, typed manually).  
   - If this **fails** (timeout, “cannot connect”), fix networking before scanning the QR again.  
   - If Safari **works** but the Even app does not, the issue is with how that app loads URLs, not the Mac.

4. **macOS Firewall** — **System Settings → Network → Firewall**. If the firewall is on, either allow **Node** (or “incoming connections” for the terminal) or turn the firewall off briefly to test.

5. **Router “client isolation” / guest SSID** — Some routers block phone ↔ laptop even on “main” Wi‑Fi. Guest networks almost always do. If you can, disable **AP / station isolation** in the router or use a different SSID that allows local devices to talk to each other.

6. **VPN** — Turn off VPN on the **Mac** and **phone** while testing; VPNs often break access to `192.168.x.x` on the local LAN.

7. **Confirm the Mac is listening** — On the Mac, with `npm run dev` running:

   ```bash
   lsof -iTCP:5173 -sTCP:LISTEN
   ```

   You should see a `node` (or `vite`) process. If nothing listens, the dev server is not up or uses another port (check the terminal for the actual port).

## Glasses audio → Google Cloud Speech (optional)

The WebView can forward **glasses PCM** from the Even bridge to a **small WebSocket proxy** on your laptop, which calls **Google Cloud Speech-to-Text (streaming)**. Service account JSON stays **only on the machine running the proxy**, not in the phone app.

1. Enable **Speech-to-Text** in a GCP project and create a **service account** key JSON.
2. On the laptop:

   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/your-service-account.json
   npm run stt-proxy
   ```

   Default listen: `ws://0.0.0.0:8787` (override with `STT_PROXY_PORT`).

3. Point the Vite app at the proxy (same LAN IP the phone uses for the dev server), e.g. in **`.env.local`**:

   ```bash
   VITE_GCP_STT_WS_URL=ws://YOUR_LAN_IP:8787
   VITE_STT_SAMPLE_RATE_HZ=16000
   VITE_STT_LANGUAGE=en-US
   ```

   Restart `npm run dev` after changing env vars. If `VITE_GCP_STT_WS_URL` is set and the Even bridge is connected, the app uses **glasses → GCP STT** and **also** keeps **Web Speech on the phone mic** so room speech still appears in the transcript alongside glasses text. If the GCP URL is unset, only Web Speech runs.

Match **`VITE_STT_SAMPLE_RATE_HZ`** to the PCM format your Even host sends (often 16 kHz mono LINEAR16); wrong values produce poor recognition.

**If the app shows “bridge audio on” then “connection closed”:** the phone’s WebSocket to the proxy failed. Use **`ws://YOUR_LAN_IP:8787`** (same IP as in the Vite QR URL), **not** `localhost` or `127.0.0.1` — from the phone, those point at the phone itself. Keep **`npm run stt-proxy`** running with valid **`GOOGLE_APPLICATION_CREDENTIALS`**, allow **TCP 8787** through the Mac firewall, and watch the proxy terminal for errors (Speech API auth, etc.).

## Other scripts

| Command | Purpose |
|--------|---------|
| `npm run build` | Typecheck and production build to `dist` |
| `npm run preview` | Serve the built app locally |
| `npm run stt-proxy` | WebSocket proxy: glasses PCM → Google Cloud Speech streaming (`GOOGLE_APPLICATION_CREDENTIALS` required) |
| `evenhub` / `eh` | After install, `npx evenhub --help` — login, init `app.json`, `pack` for distribution (see [Even Hub CLI](https://hub.evenrealities.com/docs/reference/cli)) |

## Further reading

- [Even Realities developer docs](https://hub.evenrealities.com/docs/) — architecture, packaging, and CLI.
