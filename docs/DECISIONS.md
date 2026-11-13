# Design decisions

## A web app with Web Push, not a native app

Background notifications on iPhone need a push service. For a native app that means APNs with the app developer's credentials, so every install would depend on whoever signed and published the app. Web Push avoids that: since iOS 16.4, a site added to the Home Screen can receive pushes, authenticated with a VAPID key the **site** owns. Each Lemmeknow deployment generates its own key pair, so a stranger's deployment works for them with no tie to anyone else, and Android/desktop browsers use the same protocol.

The push services (Apple's `web.push.apple.com`, Google's `fcm.googleapis.com` for Chrome, Mozilla's autopush) belong to the phone's browser vendor. They only see an encrypted payload, its size, and timing.

## Web Push on Web Crypto, no library

Node `web-push` libraries rely on `crypto` APIs that don't exist in Workers. `src/worker/webpush.ts` implements the two RFCs directly on Web Crypto, about 150 lines:

- **RFC 8291** message encryption: ephemeral ECDH P-256 key, HKDF-SHA-256 over the browser's `auth` secret, AES-128-GCM, one `aes128gcm` record (RFC 8188). The test suite reproduces the RFC's example byte for byte and decrypts with an independent implementation.
- **RFC 8292** VAPID: an ES256 JWT with `aud` = push service origin, `exp` 12 h ahead (Apple rejects more than 24 h), and `sub` = the deployment's https URL (or `vapidSubject`). Web Crypto's ECDSA output is already the raw `r||s` JWS needs. Tokens are cached per isolate for an hour.

## VAPID keys live in D1

The key pair is generated on first use and stored in `settings` as a single row (`INSERT OR IGNORE`, then read back, so concurrent first requests agree). That removes a manual "generate keys and set two secrets" step for self-hosters. The private key never leaves the database. It is never rotated automatically, because a new key invalidates every subscription.

## Cloudflare Access protects only the dashboard

Access in front of the whole hostname would break the PWA: browsers fetch the manifest and register the service worker without Access cookies, and scripts can't complete an Access login. So:

- The Access application covers only `/admin` and `/api/admin`.
- The Worker verifies `Cf-Access-Jwt-Assertion` again on those paths (RS256 signature against the team JWKS, audience, issuer, expiry), so a misconfigured policy fails closed. Only `localhost` (for `cf dev`) is exempt.
- `/api/v1` uses tokens. Topics are private unless you make one public in the dashboard.
- The PWA itself (`/`, `/sw.js`, the manifest, icons, `/assets/*`) is static content served straight from Workers Static Assets without running the Worker. It contains no data.

## Tokens instead of users

Lemmeknow keeps only **tokens with grants**, for example `alerts_*: read+write` or `family: read`. Use one per phone or script. Only a SHA-256 of each token is stored, and the plaintext is shown once. Each push subscription remembers the token it was created with, and revoking that token removes those devices, so a lost phone stops receiving notifications.

The PWA stores topic + token in the device's `localStorage`. On iPhone the Home Screen app's storage is separate from Safari's, which is why setup happens inside the installed app.

## D1 layout: packed rows

D1 bills per row read and written (and every index entry a write touches counts as another row written), so both tables are packed and have no secondary indexes:

- **`inbox`**: one row per topic per UTC day (`(topic, day, part)`), holding a JSON array of `{ s: order key, m: message }`. A publish is one atomic `INSERT … ON CONFLICT DO UPDATE` that appends with `json_insert(entries, '$[#]', …)`, batched with the topic counter update: two rows written, no reads, and concurrent publishes cannot clobber each other. A row that nears 1.5 MB spills to `part` 1, 2, … (D1's row limit is 2 MB). The hourly cron deletes a day row once every message in it has expired.
- **`push_subs`**: one row per topic holding a JSON array of subscriptions. Publishing reads exactly one row to find every device. Subscribe, unsubscribe and dead-endpoint cleanup are compare-and-swap writes on a `version` column, retried on conflict. A topic is capped at 1000 devices (~400 bytes each).

## Push delivery runs in `waitUntil`

The publish response returns as soon as the message is stored, with the number of devices that will be notified. The fan-out (one request per device, in parallel) runs under `ctx.waitUntil`, logs one structured line per publish, and deletes subscriptions the push service reports as gone (404/410). Other failures are logged and the subscription is kept. The dashboard's **Send** waits for the fan-out so it can show per-device results.

## No Durable Object, no live sockets

Web Push already delivers in real time, including to a closed app. While the PWA is open, the service worker posts each push to the page, which refreshes its inbox. There is nothing to keep a socket open for, so v0.2 dropped the WebSocket hub from v0.1.

## A clean break from v0.1

v0.1 reimplemented the ntfy protocol for the official ntfy apps, which tied iOS delivery to ntfy.sh's APNs credentials. v0.2 is its own product with its own API, and shares no routes, payloads or services with ntfy. Migration 4 drops the v0.1 message cache and keeps topics and token hashes. The old `tk_` tokens still authenticate, and new tokens use `lk_`.
