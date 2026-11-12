<img src="public/favicon.svg" width="64" height="64" alt="">

# Lemmeknow

A Cloudflare-native, [ntfy](https://ntfy.sh)-compatible push notification server. It runs entirely on Cloudflare Workers, Durable Objects, and D1. There is no VM or container to keep alive.

Publish with `curl`, and receive notifications in the **official ntfy apps** for iOS and Android. Lemmeknow is not a port of the ntfy Go binary. It reimplements the HTTP API that the apps and `curl` already use.

```sh
curl -H "Authorization: Bearer tk_..." -H "Title: Backup" -d "Nightly backup finished" https://ntfy.example.com/backups
```

## How it differs from running ntfy yourself

| | ntfy (self-hosted) | Lemmeknow |
| --- | --- | --- |
| Runtime | One Go process on your server | A Worker plus a Durable Object (hibernatable WebSockets) plus D1 |
| Default access | Open unless you configure auth | **Private**: every publisher and subscriber needs a token with explicit read/write grants. You can make individual topics anonymous. |
| Users | Username/password accounts | Tokens only. The apps "log in" with any username and the token as the password. |
| Admin UI | ntfy web app | A dashboard at `/admin` behind **Cloudflare Access** (JWT verified again in the Worker) |
| iOS background delivery | `upstream-base-url` (ntfy.sh) | Same mechanism: an empty `poll_request` to ntfy.sh. Message content stays on your Worker. |
| Android | Firebase or its own connection | Its own connection (JSON stream or WebSocket), entirely on Cloudflare |

### What works

- **Publish:** `PUT`/`POST /<topic>` with every ntfy header and its query aliases: title, priority (1-5 or names), tags, click, icon, actions (simple and JSON formats), markdown, attach (external URL), delay/at/in (unix time or duration), and `cache=no`. Also `GET /<topic>/publish|send|trigger`.
- **Publish as JSON:** `PUT`/`POST /` with `{"topic": "...", "message": "...", ...}`.
- **Subscribe:** `/<topics>/json` (NDJSON), `/sse`, `/raw`, and `/ws`. Multiple topics work (`/a,b,c/json`). The stream sends `open`, `message`, and `keepalive` (every 45 s).
- **Poll and replay:** `poll=1`, `since=all|latest|none|<unix>|<duration>|<message id>`, `scheduled=1`, and the `id`, `message`, `title`, `tags`, and `priority` filters.
- **Auth, the same ways ntfy accepts it:** `Authorization: Bearer`, `Authorization: Basic` (any username, token as password), and `?auth=<base64url>`. `GET /<topics>/auth` lets the apps check credentials.
- **Probe endpoints:** `/v1/health`, `/v1/config`, `/v1/stats`, `HEAD /`, plus UnifiedPush discovery (`?up=1`).
- **iOS wakeups:** after a publish, the Worker sends `POST <upstream>/<sha256(base-url + "/" + topic)>` with `X-Poll-ID`. This matches ntfy's `forwardPollRequest`.
- **Scheduled delivery and cleanup:** a once-a-minute cron delivers delayed messages and prunes expired ones. The cache keeps messages for 12 h by default.
- **Dashboard:** topics, live subscriber counts, token minting with per-topic read/write grants (wildcards allowed), the recent message log, a send-test form, and copy-paste setup instructions for the apps.

### Not yet supported

- File uploads (attachments stored in R2). External `attach` URLs work.
- E-mail, phone calls, Matrix, and web push. These return ntfy's "not supported" errors.
- User accounts, reservations, the ntfy web app, message templates, and message updates/deletes (`sequence_id`).
- Natural-language delays such as "tomorrow, 10am". Unix timestamps and durations work.
- Rate limiting beyond what Cloudflare provides.

## Deploy

You need a Cloudflare account with a zone for your hostname, Node 22+ (Node 24 is recommended), and a Workers Paid plan for Durable Objects with SQLite.

1. **Install:**

   ```sh
   git clone https://github.com/<you>/lemmeknow && cd lemmeknow && npm install
   ```

2. **Create a Cloudflare Access application** (Zero Trust → Access → Applications → Self-hosted):
   - Destinations: `ntfy.example.com/admin` **and** `ntfy.example.com/api/admin`. Only these paths are protected. Never put Access in front of the whole hostname, because the phone apps can't get past a login page.
   - Add a policy that allows you, for example by your e-mail address.
   - Copy the application's **AUD tag**.
3. **Configure:** copy `lemmeknow.config.example.json` to `lemmeknow.config.json` and fill it in. The real file is gitignored.

   | key | meaning |
   | --- | --- |
   | `accountId` | Your Cloudflare account ID |
   | `host` | Hostname to serve, e.g. `ntfy.example.com` (a custom domain is attached on deploy) |
   | `baseUrl` | The URL you enter in the apps, with no trailing slash. Defaults to `https://<host>`. It must match the apps exactly, because the iOS wakeup hash depends on it. |
   | `accessTeamDomain` | `<team>.cloudflareaccess.com` |
   | `accessAud` | The AUD tag from step 2 |
   | `upstreamBaseUrl` | `https://ntfy.sh` (default). Set it to `""` to disable iOS wakeups. |
   | `cacheDurationSeconds` | How long messages stay pollable. Default: `43200` (12 h). |

   You can use `LEMMEKNOW_*` environment variables instead (e.g. `LEMMEKNOW_HOST`); they override the file.
4. **Optional secret.** Upstream wakeups come from Cloudflare's shared egress IPs, so ntfy.sh's anonymous per-IP limits can be hit. With an ntfy.sh account token, the requests count against your account instead:

   Add `UPSTREAM_ACCESS_TOKEN` as a secret on the `lemmeknow` Worker, either in the dashboard (Workers & Pages → lemmeknow → Settings → Variables and Secrets) or with `npx cf workers secrets`.

5. **Deploy:** `npx cf deploy`. The first deploy provisions the D1 database (`lemmeknow-db`) and the Durable Object, and the schema migrates itself on the first request.
6. Open `https://ntfy.example.com/admin`, create a topic, and mint a token.

## Point the official apps at it

The dashboard's **App setup** page and the "token created" dialog show these steps with your real URL filled in.

**iOS (ntfy for iOS)**
1. Settings → Users → Add user. Service URL: `https://ntfy.example.com`. Username: anything. Password: your token.
2. Tap + to add a topic → turn on "Use another server" → enter `https://ntfy.example.com`.

Background notifications arrive through the ntfy.sh wakeup. The app then fetches the message from your server by ID.

**Android (Google Play or F-Droid)**
1. Settings → Manage users → Add user: your server URL, any username, and the token as the password.
2. Tap + to add a topic → "Use another server" → your URL. Turn on instant delivery.
3. Recommended: Settings → Connection protocol → **WebSockets**. WebSocket subscribers hibernate in the Durable Object, which is the cheapest way to keep a phone connected.

**Scripts**

```sh
curl -u ":tk_..." -d "Disk 91% full" -H "Priority: high" -H "Tags: warning" https://ntfy.example.com/alerts
curl -s -H "Authorization: Bearer tk_..." "https://ntfy.example.com/alerts/json?poll=1&since=1h"
```

## Develop

```sh
npx cf dev        # http://localhost:5173. On localhost the dashboard skips Access.
npm test          # Vitest: publish parsing, auth, message JSON, poll/since/id, iOS poll_request
npm run typecheck
```

To create a token locally:

```sh
curl -X POST localhost:5173/api/admin/tokens -H 'content-type: application/json' \
  -d '{"label":"dev","grants":[{"topic":"*","read":true,"write":true}]}'
```

Design notes, including the Access-versus-apps split and the iOS upstream tradeoff, are in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Credits

[ntfy](https://github.com/binwiederhier/ntfy) is by Philipp C. Heckel. Lemmeknow reimplements its public HTTP API so the official ntfy apps can use a Cloudflare-hosted server. It is not affiliated with the ntfy project.

## License

MIT
