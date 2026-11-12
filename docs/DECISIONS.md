# Design decisions

## Cloudflare Access protects the dashboard, never the protocol

The official ntfy apps speak plain HTTP and WebSocket with Basic or Bearer auth. They can't complete a Cloudflare Access login, so if Access sat in front of the whole hostname, phones would get an HTML login page instead of JSON. For that reason:

- The Access application covers only `/admin` (the dashboard) and `/api/admin` (its API).
- The Worker verifies the `Cf-Access-Jwt-Assertion` header again on those paths, checking the RS256 signature against the team's JWKS plus the audience, issuer, and expiry. A misconfigured Access policy therefore fails closed. The only exception is requests to `localhost` during `cf dev`.
- The ntfy API on every other path uses tokens. There are no anonymous topics unless you enable them per topic in the dashboard.
- `/assets/*` (the compiled dashboard JavaScript and CSS) is public static content. It contains no data, and every API call it makes is behind Access.

## Tokens instead of users

ntfy has users, passwords, ACLs, and tokens. Lemmeknow keeps only **tokens with grants**, for example `alerts_*: read+write` or `family: read`. That's simpler to run and simpler to revoke: use one token per phone or script.

The apps' "user" login still works. Lemmeknow ignores the Basic auth username and treats the password as the token, which is also how ntfy treats Basic auth with an empty username. Only a SHA-256 of each token is stored, and the plaintext is shown once.

## iOS needs a wakeup from ntfy.sh

Apple only delivers background pushes through APNs, and only the ntfy.sh project holds the official iOS app's APNs credentials. ntfy solves this for self-hosted servers with `upstream-base-url`, and Lemmeknow does exactly the same thing (see `src/worker/ntfy/upstream.ts`):

```
POST https://ntfy.sh/<hex(sha256("<base-url>/<topic>"))>
X-Poll-ID: <message id>
(empty body)
```

The iOS app subscribes to that hash for every topic on a custom server. When it receives the `poll_request`, it calls `GET <base-url>/<topic>/json?poll=1&id=<id>` on your server. The hash and URL format come from `server.go` (`forwardPollRequest`) and the iOS app's `Helpers.swift` (`topicHash`, which strips trailing slashes from the base URL).

Tradeoffs:

- **Content stays private.** ntfy.sh sees only the topic hash, the message ID, and the timing. It never sees the topic name or the message.
- **`baseUrl` must match what you typed in the app.** Otherwise the hashes differ and iOS never wakes up. Set `baseUrl` explicitly if you serve more than one hostname.
- **Rate limits.** Workers make outbound requests from shared Cloudflare IPs, and anonymous ntfy.sh limits are per IP. Set the `UPSTREAM_ACCESS_TOKEN` secret (an ntfy.sh account token) to use your account's limits.
- **No wakeup for uncached messages.** Messages published with `Cache: no` don't trigger a wakeup, because the app couldn't fetch them anyway. Upstream ntfy still forwards in this case; Lemmeknow deliberately doesn't.
- Set `upstreamBaseUrl` to `""` to turn this off. iOS then only receives messages while the app is open. Android doesn't need any of this.

## One hub Durable Object, not one per topic

Live subscribers are WebSockets that hibernate in a single `Hub` Durable Object:

- The Android app multiplexes **all topics on one connection** (`/a,b,c/json` or `/a,b,c/ws`). Per-topic objects would need one connection per topic, and a Worker can hold at most six outbound connections per request, which would cap a phone at six topics.
- One object comfortably handles thousands of sockets and far more publishes than a personal or team server sees.
- App WebSockets (`/…/ws`) are handed directly to the hub, so they hibernate between messages and an idle phone costs almost nothing. The hub sends a `keepalive` every 45 s using an alarm.
- HTTP streams (`/json`, `/sse`, `/raw`) are held by the Worker, which bridges them to the hub over one internal hibernatable WebSocket. Idle wall time in a Worker isn't billed, while an open HTTP stream would keep a Durable Object awake.

If you ever need more scale, shard the hub by topic hash and have multi-topic subscribers bridge to each shard.

## D1 is the message cache, packed one row per topic per hour

Messages live in D1 for `cacheDurationSeconds` (12 h by default, the same as ntfy). D1 serves `poll`, `since=<id|time|duration|latest|all>`, the iOS `id=` fetch, and scheduled delivery.

D1 bills per row read and written (and counts every index entry a write touches as another row written), so the cache is packed the way Richter packs check history: the `buckets` table holds **one row per topic per UTC hour**, keyed `(topic, hour, part)`, with a JSON array of entries `{ p, s, m }` (published flag, order key, the ntfy message). Scheduled messages sit in the bucket of their delivery hour with `p = 0`. With 12 h retention a topic has about 13 rows, however chatty it is.

- **Publish** is one atomic `INSERT … ON CONFLICT DO UPDATE` that appends to the hour's array with `json_insert(entries, '$[#]', …)` and updates the bucket's counters (published count, min/max expiry, next due time). There is no read-modify-write, so concurrent publishes to the same topic cannot clobber a bucket, and no Durable Object round trip is needed to serialize them. A published message also bumps the topic's `message_count`/`last_message_at` in the same batch: two rows written per publish, no reads.
- **Reads** (`poll`, `since`, the iOS `?poll=1&id=`, WebSocket replay, the dashboard log) load only the requested topics' bucket rows (narrowed by hour for `since=<time>`, and skipping future hours unless `scheduled=1`) and filter in memory. Ordering is `(time, s)`, where `s` is a microsecond-resolution insertion key, so `since=<id>` never skips or repeats messages that share a timestamp.
- **Counts**: the dashboard's "cached" column and `/v1/stats` sum the per-bucket `published` counters. They never count messages one row at a time.
- **Cron** (every minute): due scheduled messages are claimed by rewriting their bucket with a compare-and-swap on a `version` column that every write bumps, so a message is delivered exactly once even if a publish lands mid-rewrite (the cron re-reads and retries). Buckets whose newest message has expired are deleted. Expired entries in live buckets are skipped on read and only stripped once they are 10 minutes stale, which caps rewrites at a handful per bucket per hour.
- **Size**: D1 caps a row at 2 MB. When an hour's bucket nears 1.5 MB, the append's `WHERE` clause refuses it and the message goes to `part` 1, 2, … of the same hour.
- The table has no secondary indexes on purpose. The cron scans bucket metadata (a few rows per topic), which costs reads but saves an index write on every publish.
- **Migration**: the first release stored one row per message. Schema migration 2 copies any such rows into buckets (keeping their order) and drops the old table.
