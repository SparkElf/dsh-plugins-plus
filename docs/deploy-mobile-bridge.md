# Mobile bridge deployment runbook

Two halves: the public bridge server (this repo, `@sparkelf/dsh-mobile-bridge-server`) and the local plugin (`@sparkelf/dsh-mobile-bridge`) installed into the owner's Harness profile. Bridges dial OUT, so the home network needs no inbound ports.

## Server

1. Provision a Linux box with Node 22.19+ (or 24+) and a TLS-terminated public hostname (nginx/Caddy in front; the server itself speaks plain HTTP on a loopback port).
2. `git clone <dsh-plugins-plus> && cd dsh-plugins-plus && corepack enable && pnpm install`.
3. Create a service env with:
   - `MOBILE_BRIDGE_SECRET` — 16+ char HMAC secret for session tokens.
   - `MOBILE_BRIDGE_DATA` — absolute path of the users JSON (mode 0600, e.g. `/var/lib/dsh-mobile-bridge/users.json`).
   - `MOBILE_BRIDGE_PORT` — loopback port behind the TLS proxy (default 8787).
4. Run `packages/mobile-bridge-server/src/index.ts` under systemd:

```ini
[Service]
ExecStart=node --import tsx/esm /opt/dsh-plugins-plus/packages/mobile-bridge-server/src/index.ts
EnvironmentFile=/etc/dsh-mobile-bridge.env
Restart=on-failure
User=dshbridge
```

5. Verify: `curl https://<host>/` returns the landing page; register/login/bind round-trip works.

## Local Harness side

1. In the Harness install, `dsh plugin --profile web add github:SparkElf/dsh-plugins-plus#<sha>` is not package-granular; instead add the plugin package to the profile (`pnpm add` in `$DSH_HOME/profiles/web`) and append its patch row to the profile `cordis.patch.yml` with config:

```yaml
- insert:
    - id: mobile-bridge
      name: '@sparkelf/dsh-mobile-bridge'
      config:
        serverUrl: https://<host>
        secret: <bridge secret>
        localPort: 3085
```

2. Restart Harness; the plugin logs `pairing code: <6 hex>`.
3. On the phone: open `https://<host>/`, register (username/password), log in, paste the pairing code, bind. The client then relays HTTP through the tunnel to the local web; the mobile overlay stylesheet loads at `/mobile/bridge/style.css`.

## Third-party login (later)

`createBridgeServer(store, { externalAuth: { wechat: verifier } })` adds providers; the verifier checks the provider payload and returns the stable external id; `POST /api/login/external {provider, payload}` mints tokens and creates users on first sight. Password login stays available.
