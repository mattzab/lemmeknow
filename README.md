<img src="public/favicon.svg" width="64" height="64" alt="">

# Lemmeknow

Push notifications to your phone from your own Cloudflare account. Lemmeknow is a small Worker, a D1 database and an installable web app (PWA). Scripts publish over a simple HTTP API, and the Worker delivers each message with standard **Web Push** to every phone that subscribed.

```sh
curl -fsS -m 10 --retry 3 --data-raw 'Nightly backup finished' \
  'https://lemmeknow.example.com/lk_your_token/backups?title=Backup'
```

- **Nothing to install from an app store.** iPhone (iOS 16.4+) and Android open your deployment's URL and add it to the Home Screen.
- **No central service.** Each deployment generates its own VAPID key pair on first use and keeps it in its own D1 database. There is no Firebase project, no relay and no account with anyone but Cloudflare. Pushes go straight from your Worker to the push service of the phone's browser (Apple for iPhone, Google for Chrome on Android), exactly as Web Push is designed.
- **Private by default.** Every topic needs a token with an explicit read or write grant. Tokens are minted in a dashboard protected by Cloudflare Access.
- **Log in with your e-mail.** Invite people by e-mail from the dashboard. They tap **Log in** in the app, get a one-time code from Cloudflare Access, and find their topics and their own permanent token waiting.
- **Cheap.** It fits the Workers free plan for personal use. Messages are packed into one D1 row per topic per day, and push subscriptions into one row per topic.

## How it works

```
script ──POST /api/v1/topics/alerts/messages──▶ Worker ──▶ D1 (inbox)
                                                  │
                                    ctx.waitUntil │  RFC 8291 encrypted, VAPID-signed
                                                  ▼
                       web.push.apple.com / fcm.googleapis.com / Mozilla push
                                                  │
                                                  ▼
                       phone ── service worker shows the notification
```

1. The phone opens the PWA, you add a topic and a token, and the browser asks to allow notifications.
2. The PWA subscribes with `PushManager.subscribe()` using the deployment's VAPID public key and registers the subscription with `POST /api/v1/topics/<topic>/subscriptions`.
3. A publish stores the message in the topic's inbox and, in the background, sends one encrypted push per subscribed device. Dead subscriptions (404/410 from the push service) are removed automatically.
4. Tapping the notification opens its link, or the Lemmeknow inbox.

The Web Push implementation (`src/worker/webpush.ts`) uses only Web Crypto. It is tested against the RFC 8291 example vector.

## Publish URL

The quickest way to publish is a URL with the token and topic in it, like a heartbeat URL:

```
https://<host>/<token>/<topic>
```

GET, HEAD, POST and PUT all publish (the token needs write access to the topic). Options go in the query: `title`, `body` (or `msg`), `url`, `priority`, `tags`. A POST/PUT body is the message text, or a JSON object as in the API below. With no message at all it sends "Ping". The answer is `201 { ok, id, topic, devices }`.

```sh
# from a script
curl -fsS -m 10 --retry 3 --data-raw 'Disk is 90% full' 'https://lemmeknow.example.com/lk_your_token/alerts?title=Disk&priority=4'

# GET only, e.g. from cron or an uptime monitor
curl -fsS -m 10 --retry 3 'https://lemmeknow.example.com/lk_your_token/backups?body=Backup%20done'
```

The dashboard's **Curl** page (and *Curl* in the signed-in app) builds these with your real host, token and topic, with one-tap copy and a **Send it now** button.

The token is part of the URL, so it can end up in shell history, cron mail, proxy and access logs, and Cloudflare's own request logs. Use a token that can only write to the topics it needs, and revoke it if it leaks. Link previewers (chat apps unfurling a pasted URL) also fetch with GET, which publishes. To keep the token out of URLs, use the header API instead.

## API

All endpoints are under `/api/v1`, take and return JSON, and report errors as `{ "error": "...", "field": "..." }`. Authenticate with `Authorization: Bearer <token>`.

| Method | Path | Grant | |
| --- | --- | --- | --- |
| `POST` | `/topics/{topic}/messages` | write | Publish. JSON `{ body, title?, url?, priority?, tags? }`, or a plain-text body with `title`, `url`, `priority`, `tags` as query parameters. Returns `201 { message, devices }`. |
| `GET` | `/topics/{topic}/messages?limit=&since=` | read | The inbox, newest first. `since` is a Unix time in seconds. |
| `POST` | `/topics/{topic}/subscriptions` | read | Register a device: `{ subscription: PushSubscription.toJSON() }`. |
| `DELETE` | `/topics/{topic}/subscriptions` | none | Unregister: `{ endpoint }`. The endpoint itself is the secret. |
| `GET` | `/me` | personal token | `{ email, role, token, grants, topics }` for the token's owner. |
| `POST` | `/pair` | none | `{ code }` from a signed-in browser → the same as `/me`. One-time, 10 minutes. |
| `GET` | `/push/key` | none | `{ public_key }`: the VAPID key for `PushManager.subscribe()`. |
| `GET` | `/health` | none | `{ ok, version }` (also `/healthz`). |

Message fields: `body` (up to 4000 characters), `title` (200), `url` (http/https, opened on tap), `priority` 1–5 (default 3; 4 and 5 are sent with high urgency, 5 stays on screen, 1 is silent), `tags` (up to 10). Messages stay in the inbox for 7 days by default.

Topic names are 1–64 letters, digits, `-` or `_`. A token grants read and/or write on topic names or `*` patterns (for example `alerts_*`).

```sh
# JSON
curl -X POST https://lemmeknow.example.com/api/v1/topics/alerts/messages \
  -H "Authorization: Bearer lk_..." -H "Content-Type: application/json" \
  -d '{"title":"Disk","body":"/ is 90% full","priority":4,"url":"https://grafana.example.com"}'

# Read the inbox
curl -H "Authorization: Bearer lk_..." "https://lemmeknow.example.com/api/v1/topics/alerts/messages?limit=10"
```

## Deploy your own

You need a Cloudflare account with a zone (domain) for the hostname, and Node 22+ (24 recommended). Everything below happens in your account.

1. **Install**

   ```sh
   git clone https://github.com/mattzab/lemmeknow && cd lemmeknow && npm install
   npx cf auth login   # or set CLOUDFLARE_API_TOKEN
   ```

2. **Protect the dashboard and the login with Cloudflare Access** (Zero Trust → Access → Applications → Add → Self-hosted). Add these destinations on your hostname, and only these: paths `admin`, `api/admin`, `api/me` and `login` (Access covers sub-paths of each). Do **not** put Access in front of the whole hostname: the PWA, its service worker and manifest, `/api/v1` and `/access/*` must stay public, or phones cannot install the app or receive pushes. Turn on the **One-time PIN** login method, add a policy that includes your own e-mail, then copy the application's **AUD tag**.

3. **Configure.** Copy `lemmeknow.config.example.json` to `lemmeknow.config.json` (gitignored) and fill it in:

   | key | meaning |
   | --- | --- |
   | `accountId` | Your Cloudflare account ID |
   | `host` | Hostname to serve, e.g. `lemmeknow.example.com`. The custom domain (and its DNS record) is attached on deploy. |
   | `baseUrl` | Public URL, no trailing slash. Defaults to `https://<host>`. |
   | `accessTeamDomain` | `<team>.cloudflareaccess.com` |
   | `accessAud` | The AUD tag from step 2 |
   | `adminEmails` | Your e-mail (comma-separate several). These owners are always admins and cannot be removed from the dashboard. If empty, anyone your Access policy lets in is an admin until the first user is invited. |
   | `retentionDays` | How long messages stay in the inbox. Default `7`. |
   | `vapidSubject` | Optional contact for push services, `mailto:you@example.com` or an https URL. Defaults to `baseUrl`. |

   `LEMMEKNOW_*` environment variables (e.g. `LEMMEKNOW_HOST`, `LEMMEKNOW_ADMIN_EMAILS`) override the file, which is handy in CI.

4. **Deploy:** `npx cf deploy`. The first deploy creates the D1 database `lemmeknow-db`. The schema migrates itself, and the VAPID and Access-evaluation keys are generated, on first request. There are no secrets to set.

5. **Let invited people through Access.** Edit the policy from step 2 and add a second Include rule of type **External Evaluation**:

   | Evaluate URL | Keys URL |
   | --- | --- |
   | `https://<host>/access/evaluate` | `https://<host>/access/keys` |

   Access then asks your Worker, after each e-mail login, whether that address is on the Users list (owners included), and the Worker answers with a signed yes or no. Keep your own e-mail rule in the policy too, so you can always get in. The dashboard's **Users** page shows these URLs.

6. Open `https://<host>/admin`, create a topic, mint a token, and use **Send** to try it. Add people on the **Users** page.

## Users, login and tokens

- **Log in.** The app at `https://<host>/` has a small **Log in** button. It goes through Cloudflare Access (an e-mailed one-time code) and lands back in the app, signed in. You then see your topics with one-tap **Add**, and your personal token.
- **Tokens never expire and stay copyable.** Every token, including each person's personal token, is stored in full in D1 so it can be copied again from the app (your own) or the dashboard (all of them). That means **anyone who can open the dashboard can see every token**; only make people admins whom you trust with that. Revoke a token to cut it off; **New value** issues a fresh one and keeps phones that subscribed with the old one. Tokens made before 0.3 were stored only as a hash: they show as *not viewable*, and **Replace** gives them a copyable value with the same name and grants.
- **Users.** On the dashboard's **Users** page, add someone by e-mail as a **member** (the app plus their own token, limited to the topics you grant) or an **admin** (everything). Removing someone ends their login, revokes their tokens and unsubscribes their phones. Access sessions can outlive that, but the Worker checks the Users list on every request.
- **iPhone Home Screen app.** The installed app has its own cookies, separate from Safari. Logging in from inside it normally works. If the e-mail login ends up in Safari instead, open the app's page in Safari, tap your name → **Code for Home Screen app**, and type the code into **Log in** → *Enter its code* inside the installed app.

## Install on a phone

**iPhone (iOS 16.4 or later)**

1. Open `https://<host>/` in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **Lemmeknow** from the Home Screen icon. Web Push only works there, not in a Safari tab.
4. Tap **Log in** and sign in with your e-mail, then **Add** a topic and tap **Allow**. (Or type a topic and a token under **Add a topic**.)
5. Tap the send icon next to the topic (with a write token) or use **Send** in the dashboard. The notification should arrive even with the app closed.

The Home Screen app has its own storage, separate from Safari, so log in (or enter the token) inside the installed app.

**Android (Chrome)**

1. Open `https://<host>/` in Chrome. Optionally ⋮ → **Add to Home screen** → **Install**.
2. Tap **Log in**, then **Add** a topic (or enter a topic and token), then **Allow**.

Desktop Chrome, Edge, Firefox and Safari work too.

## Develop

```sh
npm run dev        # cf dev: Worker + Vite on localhost (Access is bypassed on localhost only;
                   # the x-dev-access-email header picks who you are there)
npm test           # Vitest: Web Push crypto, API, store, users and login
npm run typecheck
```

Layout: `src/worker` (Hono API, Web Push, D1 store), `src/pwa` (the public app), `src/client` (the dashboard), `public/sw.js` (service worker), `cloudflare.config.ts` (deployment). Design notes are in [docs/DECISIONS.md](docs/DECISIONS.md).

## Limits

- A topic holds up to 1000 devices. On the Workers free plan, one publish can reach about 45 devices (50 subrequests per invocation); the paid plan raises that far beyond the per-topic cap.
- Push payloads are capped at 4 KB by push services, so very long bodies are shortened in the notification. The full text stays in the inbox.
- No attachments, scheduled delivery, or e-mail/SMS.

## License

MIT. See [LICENSE](LICENSE).
