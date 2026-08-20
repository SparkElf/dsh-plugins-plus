# Mobile bridge deployment runbook

Two halves: the public bridge server (this repo, `@sparkelf/dsh-mobile-bridge-server`) and the local plugin (`@sparkelf/dsh-mobile-bridge`) installed into the owner's Harness profile. Bridges dial OUT, so the home network needs no inbound ports. Accounts are email verification codes or WeChat; there is no password login. Relay bodies stay opaque base64 so the server never reads client payload bytes (the E2EE layer encrypts them client-side).

## Server

1. Provision a Linux box with Node 22+ and a TLS-terminated public hostname. When the host already runs another app (e.g. sub2api) behind nginx, split by path: `/bridge/`, `/ws/`, and the exact service-worker path `/sw.js` go to the bridge port, while everything else keeps the existing proxy:

```nginx
location = /sw.js {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location /bridge/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location /ws/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

2. Bundle the server with `pnpm dlx esbuild@0.27.0 packages/mobile-bridge-server/src/index.ts --bundle --platform=node --format=esm --banner:js="import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" --outfile=bridge-server.mjs`. Deploy `bridge-server.mjs` and `packages/mobile-bridge-server/src/deepseek-logo.svg` under `/opt/dsh-mobile-bridge`. Camera scanning serves two exact lazy runtimes. Copy `qr-scanner@1.4.2` `package.json`, `qr-scanner.umd.min.js`, `qr-scanner-worker.min.js`, and `LICENSE` under `/opt/dsh-mobile-bridge/node_modules/qr-scanner/`. Copy `zxing-wasm@3.1.3` `package.json`, `dist/cjs/reader/index.js`, `dist/iife/reader/index.js`, and `dist/reader/zxing_reader.wasm` under `/opt/dsh-mobile-bridge/node_modules/zxing-wasm/`. The initial login does not reference either scanner runtime; clicking the camera loads only the capability-selected JavaScript and its worker/WASM. Omitting the ESM banner or either declared runtime makes the service fail at startup. Third-party attribution and complete license texts are in `packages/mobile-bridge-server/THIRD_PARTY_NOTICES.md`.
3. Write `/etc/dsh-mobile-bridge.env` (mode 0600) with:
   - `MOBILE_BRIDGE_SECRET` — 32-byte hex, HMAC secret for session tokens.
   - `MOBILE_BRIDGE_DATA` — users JSON path (e.g. `/var/lib/dsh-mobile-bridge/users.json`).
   - `MOBILE_BRIDGE_PORT` — loopback port behind the TLS proxy (8787).
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` — email verification delivery (QQ/163/Gmail SMTP all work; absent disables email login).
   - `WECHAT_APP_ID`, `WECHAT_APP_SECRET` — optional WeChat QR login.
4. systemd unit with `EnvironmentFile` and `ExecStart=/usr/bin/node /opt/dsh-mobile-bridge/bridge-server.mjs`, `Restart=on-failure`; enable and start.
5. Verify the mobile login in a browser: `/sw.js` must return `Content-Type: text/javascript` plus `Service-Worker-Allowed: /`; scan a live desktop QR and confirm the mobile Harness renders. The co-hosted app behind `/` remains unaffected before service-worker registration. The scanner accepts only the same relay hostname with an optional leading `www.` difference and then navigates to the exact origin encoded by the desktop QR; provision valid TLS and an nginx redirect for both aliases so users never need to bypass a certificate warning.
6. While the camera scanner is open, `journalctl -u dsh-mobile-bridge -f` records bounded `[mobile-bridge scanner]` events every two seconds: library/camera readiness, actual track settings, scan attempts, decoder errors, and accepted/rejected transitions. The diagnostic channel accepts only structured text telemetry; it never sends or accepts camera frames, decoded QR contents, cookies, or pairing credentials. Messages remain limited to 8 KiB and 180 per connection, and the whole connection remains limited to ten minutes.

## Local Harness side

1. Install the complete Host and Client plugin into the Web profile:

```sh
dsh plugin --profile web add @sparkelf/dsh-mobile-bridge@0.2.5
```

2. Open Harness Settings > Mobile Bridge. Set the HTTPS server URL and local Harness Web port; set the mobile sign-in duration (seven days by default), and optionally set a passphrase, owner email, and scan-time email second factor. Save the configuration and wait for the new six-character pairing code and QR to appear with Connected status.
3. Scan the displayed QR from each phone. The branded phone login scans through the rear camera, requests a high-resolution rear-camera stream, applies negative exposure compensation when supported, scores available focus distances once and locks the sharpest setting, decodes only the visible framing guide, outlines a recognized QR before continuing, persists language and theme choices, establishes Service Worker control before consuming the ticket, and reopens without another scan while the desktop-defined sign-in cookie remains valid. The desktop keeps one unconsumed five-minute ticket visible: expiry or a successful pairing replaces only that ticket, while existing devices retain their stable bridge and E2EE secret. Settings lists each device and IP; taking one device offline revokes its sessions immediately, suspends all of its Harness tunnel requests, and opens a scan-again modal over that phone’s current Harness page without affecting other devices. The server cannot rotate a ticket or manage devices without the private desktop credential.
4. Disabling or removing the bundle removes the Host routes, outbound connection, and Settings entry together. There is no standalone HTML configuration panel.

## Authentication

Email verification-code login is available when SMTP is configured. Setting `WECHAT_APP_ID` and `WECHAT_APP_SECRET` also enables WeChat URL Scheme login; external-provider verification creates or resumes the stable bridge identity while email login remains available.
