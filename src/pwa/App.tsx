import type { MeInfo, Message } from "@shared/types";
import { Bell, BellOff, BellRing, Check, Terminal, ExternalLink, Inbox, PlusCircle, RefreshCw, Send, Share, SquarePlus, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/logo";
import { Badge, TagChip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { ago, dateTime, PRIORITY_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CurlBuilder } from "@/components/curl-builder";
import { AccountCard, AccountChip, LoginCard } from "./Account";
import { api, ApiError, currentSubscription, ensurePushSubscription, isAndroid, isIOS, isStandalone, loadAccount, loadSaved, permission, pushSupported, type SavedTopic, sessionMe, storeAccount, storeSaved } from "./push";

/**
 * Top padding that clears the iPhone status bar and the Liquid Glass fade under it: the safe-area
 * inset plus ~40% more (about 1.2-1.5rem on notched phones). Desktop has no inset, so 1rem.
 */
const SAFE_TOP = "max(1rem, calc(env(safe-area-inset-top, 0px) * 1.4))";

type Notice = { kind: "ok" | "error"; text: string } | null;

function useNow(ms: number) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(id);
	}, [ms]);
	return now;
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
	return (
		<li className="flex gap-3">
			<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{n}</span>
			<span className="pt-0.5">{children}</span>
		</li>
	);
}

/** iPhone: Web Push only works once the site is on the Home Screen and opened from there. */
function InstallIOS() {
	return (
		<Card className="p-5">
			<div className="flex items-center gap-2 font-semibold">
				<SquarePlus className="size-5 text-primary" /> Add Lemmeknow to your Home Screen
			</div>
			<p className="mt-1 text-sm text-muted-foreground">iPhone only delivers notifications to web apps opened from the Home Screen (iOS 16.4 or later).</p>
			<ol className="mt-4 grid gap-3 text-sm">
				<Step n={1}>
					Open this page in <b>Safari</b>.
				</Step>
				<Step n={2}>
					Tap <Share className="inline size-4 align-text-bottom" /> <b>Share</b>, then <b>Add to Home Screen</b>. Leave <b>Open as Web App</b> on, then tap <b>Add</b>.
				</Step>
				<Step n={3}>
					Open <b>Lemmeknow</b> from the Home Screen icon, add a topic, and tap <b>Allow</b> when asked about notifications.
				</Step>
			</ol>
		</Card>
	);
}

type InstallPrompt = Event & { prompt: () => Promise<void> };

function InstallAndroid({ prompt }: { prompt: InstallPrompt | null }) {
	return (
		<Card className="p-5">
			<div className="flex items-center gap-2 font-semibold">
				<SquarePlus className="size-5 text-primary" /> Install the app (recommended)
			</div>
			<p className="mt-1 text-sm text-muted-foreground">
				Notifications work in Chrome already. Installing gives Lemmeknow its own icon and window.
			</p>
			{prompt ? (
				<Button className="mt-4" onClick={() => void prompt.prompt()}>
					<SquarePlus /> Install Lemmeknow
				</Button>
			) : (
				<p className="mt-3 text-sm">
					In Chrome, open the <b>⋮</b> menu and tap <b>Add to Home screen</b> → <b>Install</b>.
				</p>
			)}
		</Card>
	);
}

function PermissionHelp({ state }: { state: ReturnType<typeof permission> }) {
	if (state === "denied") {
		return (
			<Card className="border-amber-500/40 p-4 text-sm">
				<div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
					<BellOff className="size-4" /> Notifications are blocked
				</div>
				<p className="mt-1 text-muted-foreground">
					{isIOS() ? "Open Settings → Notifications → Lemmeknow and turn on Allow Notifications, then reopen the app." : "Allow notifications for this site in your browser's site settings, then reload."}
				</p>
			</Card>
		);
	}
	if (state === "unsupported" || !pushSupported()) {
		return (
			<Card className="border-amber-500/40 p-4 text-sm">
				<div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
					<TriangleAlert className="size-4" /> Push notifications are not available here
				</div>
				<p className="mt-1 text-muted-foreground">
					{isIOS() ? "Open Lemmeknow from your Home Screen (iOS 16.4+). You can still read your inbox here." : "This browser has no Web Push support. You can still read your inbox here."}
				</p>
			</Card>
		);
	}
	return null;
}

function AddTopic({ onAdd, busy, signedIn }: { onAdd: (topic: string, token: string) => void; busy: boolean; signedIn: boolean }) {
	const [topic, setTopic] = useState("");
	const [token, setToken] = useState("");
	return (
		<form
			className="grid gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				onAdd(topic.trim(), token.trim());
			}}
		>
			<Field label="Topic" htmlFor="topic" hint="The topic name from your Lemmeknow dashboard.">
				<Input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="alerts" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="font-mono" required />
			</Field>
			<Field label="Token" htmlFor="token" hint={signedIn ? "Leave empty to use your own token. Or paste another token (lk_…). It stays on this device." : "A token with read access (lk_…). Leave empty for a public topic. It stays on this device."}>
				<Input id="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="lk_…" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="font-mono" autoComplete="off" />
			</Field>
			<Button type="submit" loading={busy} disabled={!topic.trim()}>
				<BellRing /> Subscribe
			</Button>
		</form>
	);
}

const PRIO_CLS: Record<number, string> = {
	4: "border-amber-500/40 text-amber-600 dark:text-amber-400",
	5: "border-red-500/40 text-red-600 dark:text-red-400",
};

function MessageCard({ m, now }: { m: Message; now: number }) {
	return (
		<Card className="p-4">
			<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<span className="font-mono font-medium text-foreground">{m.topic}</span>
				<span title={dateTime(m.time)}>{ago(m.time, now)}</span>
				{m.priority !== 3 && <Badge className={PRIO_CLS[m.priority]}>{PRIORITY_LABEL[m.priority]}</Badge>}
				{m.tags?.map((t) => <TagChip key={t} tag={t} />)}
			</div>
			{m.title && <p className="mt-2 font-semibold">{m.title}</p>}
			{m.body && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{m.body}</p>}
			{m.url && (
				<a href={m.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1 truncate text-xs text-primary hover:underline">
					<ExternalLink className="size-3 shrink-0" /> {m.url}
				</a>
			)}
		</Card>
	);
}

export default function App() {
	const [topics, setTopics] = useState<SavedTopic[]>(() => loadSaved().topics);
	const [messages, setMessages] = useState<Message[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice>(null);
	const [perm, setPerm] = useState(permission);
	const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
	const vapidKey = useRef<string | null>(null);
	const now = useNow(30_000);
	const standalone = isStandalone();
	const canPush = pushSupported() && (!isIOS() || standalone);
	const [account, setAccount] = useState<MeInfo | null>(loadAccount);
	const [session, setSession] = useState(false);
	const [accountOpen, setAccountOpen] = useState(() => new URLSearchParams(location.search).has("signed_in"));

	const saveAccount = useCallback((me: MeInfo | null) => {
		setAccount(me);
		storeAccount(me);
	}, []);

	/** Swap the token on topics saved with the old personal token (after rotation or a grant change). */
	const swapToken = useCallback((from: string | undefined, to: string) => {
		if (!from || from === to) return;
		const cur = loadSaved();
		storeSaved({ ...cur, topics: cur.topics.map((t) => (t.token === from ? { ...t, token: to } : t)) });
		setTopics(loadSaved().topics);
	}, []);

	// Who is signed in: the Access cookie first (this browser), else a token paired from Safari.
	useEffect(() => {
		const params = new URLSearchParams(location.search);
		if (params.has("signed_in")) history.replaceState(null, "", "/");
		void (async () => {
			const prev = loadAccount();
			try {
				const me = await sessionMe();
				if (typeof me === "object") {
					setSession(true);
					swapToken(prev?.token, me.token);
					saveAccount(me);
					if (params.has("signed_in")) setNotice({ kind: "ok", text: `Signed in as ${me.email}.` });
					return;
				}
				if (me === "not-invited" && params.has("signed_in")) setNotice({ kind: "error", text: "You signed in, but this address has not been invited. Ask an admin to add you." });
				if (prev) {
					const fresh = await api.me(prev.token);
					swapToken(prev.token, fresh.token);
					saveAccount(fresh);
				} else if (params.has("signed_in") && me === "signed-out") {
					setNotice({
						kind: "error",
						text: isIOS() && standalone ? "The login finished outside the app. Open Lemmeknow in Safari, tap your name → Code for Home Screen app, and enter the code here." : "Login did not finish. Try again.",
					});
					setAccountOpen(true);
				}
			} catch (e) {
				// A revoked token or removed user signs this device out; network errors keep the saved state.
				if (e instanceof ApiError && (e.status === 401 || e.status === 403)) saveAccount(null);
			}
		})();
	}, []);

	const persist = useCallback((next: SavedTopic[], endpoint?: string) => {
		setTopics(next);
		const cur = loadSaved();
		storeSaved({ topics: next, endpoint: endpoint ?? cur.endpoint });
	}, []);

	const refresh = useCallback(async () => {
		const list = loadSaved().topics;
		if (!list.length) return setMessages([]);
		setLoading(true);
		const results = await Promise.allSettled(list.map((t) => api.messages(t)));
		const all: Message[] = [];
		const errors: string[] = [];
		results.forEach((r, i) => (r.status === "fulfilled" ? all.push(...r.value) : errors.push(`${list[i].topic}: ${(r.reason as Error).message}`)));
		all.sort((a, b) => b.time - a.time);
		setMessages(all);
		setLoading(false);
		if (errors.length) setNotice({ kind: "error", text: errors.join(" · ") });
	}, []);

	// Load the inbox, the VAPID key, and keep the push registration in sync with the browser.
	useEffect(() => {
		void refresh();
		api.key().then((k) => {
			vapidKey.current = k;
			void resync(k);
		}, () => {});
		const onVisible = () => document.visibilityState === "visible" && (setPerm(permission()), void refresh());
		document.addEventListener("visibilitychange", onVisible);
		const onSw = (e: MessageEvent) => {
			if (e.data?.type === "lemmeknow:message" || e.data?.type === "lemmeknow:refresh") void refresh();
		};
		navigator.serviceWorker?.addEventListener("message", onSw);
		const onPrompt = (e: Event) => (e.preventDefault(), setInstallPrompt(e as InstallPrompt));
		window.addEventListener("beforeinstallprompt", onPrompt);
		const id = setInterval(() => document.visibilityState === "visible" && void refresh(), 60_000);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			navigator.serviceWorker?.removeEventListener("message", onSw);
			window.removeEventListener("beforeinstallprompt", onPrompt);
			clearInterval(id);
		};
	}, []);

	/** If the browser rotated or dropped the subscription, register the new one for every push topic. */
	async function resync(key: string) {
		if (!canPush || permission() !== "granted") return;
		const saved = loadSaved();
		const pushTopics = saved.topics.filter((t) => t.push);
		if (!pushTopics.length) return;
		try {
			const live = await currentSubscription();
			if (live && live.endpoint === saved.endpoint) return;
			const sub = await ensurePushSubscription(key);
			await Promise.allSettled(pushTopics.map((t) => api.subscribe(t, sub)));
			if (saved.endpoint && saved.endpoint !== sub.endpoint) await Promise.allSettled(pushTopics.map((t) => api.unsubscribe(t.topic, saved.endpoint!)));
			storeSaved({ ...loadSaved(), endpoint: sub.endpoint });
		} catch (e) {
			console.warn("push resync failed", e);
		}
	}

	async function addTopic(topic: string, tokenIn: string) {
		setNotice(null);
		const token = tokenIn || account?.token || "";
		// Ask for permission first, straight from the tap: iOS only shows the prompt for a user gesture.
		let granted = permission() === "granted";
		if (canPush && permission() === "default") {
			const p = await Notification.requestPermission();
			setPerm(p);
			granted = p === "granted";
		}
		setBusy("add");
		try {
			const entry: SavedTopic = { topic, token, push: false };
			await api.messages(entry, 1); // checks the topic name and token before saving
			let endpoint: string | undefined;
			if (canPush && granted) {
				const key = vapidKey.current ?? (vapidKey.current = await api.key());
				const sub = await ensurePushSubscription(key);
				await api.subscribe(entry, sub);
				entry.push = true;
				endpoint = sub.endpoint;
			}
			persist([...loadSaved().topics.filter((t) => t.topic !== topic), entry], endpoint);
			setNotice({ kind: "ok", text: entry.push ? `Subscribed to ${topic}. Notifications are on.` : `Added ${topic} to your inbox (notifications are off on this device).` });
			void refresh();
		} catch (e) {
			const msg = e instanceof ApiError && e.status === 401 ? "That token is unknown or expired." : e instanceof ApiError && e.status === 403 ? "That token cannot read this topic." : (e as Error).message;
			setNotice({ kind: "error", text: msg });
		} finally {
			setBusy(null);
		}
	}

	async function enablePush(t: SavedTopic) {
		setNotice(null);
		if (permission() === "default") setPerm(await Notification.requestPermission());
		if (permission() !== "granted") return;
		setBusy(`push:${t.topic}`);
		try {
			const sub = await ensurePushSubscription(vapidKey.current ?? (vapidKey.current = await api.key()));
			await api.subscribe(t, sub);
			persist(loadSaved().topics.map((x) => (x.topic === t.topic ? { ...x, push: true } : x)), sub.endpoint);
			setNotice({ kind: "ok", text: `Notifications on for ${t.topic}.` });
		} catch (e) {
			setNotice({ kind: "error", text: (e as Error).message });
		} finally {
			setBusy(null);
		}
	}

	async function removeTopic(t: SavedTopic) {
		setBusy(`rm:${t.topic}`);
		try {
			const sub = await currentSubscription();
			if (sub && t.push) await api.unsubscribe(t.topic, sub.endpoint).catch(() => {});
			persist(loadSaved().topics.filter((x) => x.topic !== t.topic));
			setMessages((m) => m?.filter((x) => x.topic !== t.topic) ?? null);
		} finally {
			setBusy(null);
		}
	}

	async function sendTest(t: SavedTopic) {
		setBusy(`test:${t.topic}`);
		setNotice(null);
		try {
			const r = await api.publish(t, { title: "Lemmeknow test", body: "If you can read this as a notification, push works on this device." });
			setNotice({ kind: "ok", text: `Test sent to ${r.devices} device${r.devices === 1 ? "" : "s"} on ${t.topic}.` });
			void refresh();
		} catch (e) {
			setNotice({ kind: "error", text: e instanceof ApiError && e.status === 403 ? "This token is read-only: send a test from the dashboard instead." : (e as Error).message });
		} finally {
			setBusy(null);
		}
	}

	async function logout() {
		if (!account) return;
		const mine = loadSaved().topics.filter((t) => t.token === account.token);
		if (mine.length && !confirm(`Log out? ${mine.map((t) => t.topic).join(", ")} will be removed from this device.`)) return;
		const sub = await currentSubscription().catch(() => null);
		if (sub) await Promise.allSettled(mine.filter((t) => t.push).map((t) => api.unsubscribe(t.topic, sub.endpoint)));
		persist(loadSaved().topics.filter((t) => t.token !== account.token));
		setMessages((m) => m?.filter((x) => !mine.some((t) => t.topic === x.topic)) ?? null);
		saveAccount(null);
		setAccountOpen(false);
		// End the Cloudflare Access session too, so the next person on this browser has to log in.
		if (session) location.href = "/cdn-cgi/access/logout";
	}

	return (
		<div className="mx-auto min-h-dvh max-w-xl px-4 pb-10" style={{ paddingTop: SAFE_TOP }}>
			<header className="flex items-center gap-2 py-3">
				<Logo />
				<span className="text-lg font-semibold tracking-tight">Lemmeknow</span>
				<span
					className={cn(
						"ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs",
						canPush && perm === "granted" ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
					)}
				>
					{canPush && perm === "granted" ? <Bell className="size-3" /> : <BellOff className="size-3" />}
					<span className="hidden min-[420px]:inline">Notifications</span>
					{canPush && perm === "granted" ? "on" : "off"}
				</span>
				<AccountChip account={account} open={accountOpen} onToggle={() => setAccountOpen((o) => !o)} />
			</header>

			<div className="grid gap-4">
				{accountOpen &&
					(account ? (
						<AccountCard
							account={account}
							session={session}
							onDevice={new Set(topics.map((t) => t.topic))}
							busy={busy}
							onAddTopic={(t) => void addTopic(t, account.token)}
							onRotated={(me) => {
								swapToken(account.token, me.token);
								saveAccount(me);
							}}
							onLogout={() => void logout()}
							onClose={() => setAccountOpen(false)}
						/>
					) : (
						<LoginCard
							onPaired={(me) => {
								saveAccount(me);
								setNotice({ kind: "ok", text: `Signed in as ${me.email}. Add your topics below.` });
							}}
							onClose={() => setAccountOpen(false)}
						/>
					))}
				{isIOS() && !standalone && <InstallIOS />}
				{isAndroid() && !standalone && <InstallAndroid prompt={installPrompt} />}
				{(!isIOS() || standalone) && <PermissionHelp state={perm} />}

				{notice && (
					<div
						role="status"
						className={cn(
							"flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
							notice.kind === "ok" ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "border-destructive/50 text-destructive",
						)}
					>
						{notice.kind === "ok" ? <Check className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
						<span>{notice.text}</span>
					</div>
				)}

				<Card className="p-5">
					<h2 className="font-semibold">Topics on this device</h2>
					{topics.length > 0 && (
						<ul className="mt-3 divide-y rounded-md border">
							{topics.map((t) => (
								<li key={t.topic} className="flex items-center gap-2 px-3 py-2">
									<span className="min-w-0 flex-1 truncate font-mono text-sm">{t.topic}</span>
									{t.push ? (
										<Badge className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
											<Bell className="size-3" /> push
										</Badge>
									) : canPush && perm !== "denied" ? (
										<Button size="sm" variant="outline" loading={busy === `push:${t.topic}`} onClick={() => void enablePush(t)}>
											<BellRing /> Enable
										</Button>
									) : (
										<Badge>inbox only</Badge>
									)}
									<Button size="icon-sm" variant="ghost" title="Send a test notification" loading={busy === `test:${t.topic}`} onClick={() => void sendTest(t)}>
										<Send />
									</Button>
									<Button size="icon-sm" variant="ghost" title="Remove from this device" loading={busy === `rm:${t.topic}`} onClick={() => void removeTopic(t)}>
										<Trash2 />
									</Button>
								</li>
							))}
						</ul>
					)}
					<details className="mt-4" open={topics.length === 0}>
						<summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-primary">
							<PlusCircle className="size-4" /> Add a topic
						</summary>
						<div className="mt-3">
							<AddTopic onAdd={(a, b) => void addTopic(a, b)} busy={busy === "add"} signedIn={!!account} />
						</div>
					</details>
				</Card>

				{account && (
					<Card className="p-5">
						<details>
							<summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
								<Terminal className="size-4 text-primary" /> Curl: notify from a script
								<span className="ml-auto text-xs font-normal text-primary">Build</span>
							</summary>
							<p className="mt-1 text-sm text-muted-foreground">A URL with your token and topic in it. Anything that fetches it sends a notification.</p>
							<div className="mt-4">
								<CurlBuilder
									compact
									baseUrl={location.origin}
									topics={account.topics.filter((t) => t.can_write).map((t) => t.name)}
									tokens={[{ id: "me", label: "Your token", token: account.token, grants: account.grants }]}
									preferTokenId="me"
								/>
							</div>
						</details>
					</Card>
				)}

				<section>
					<div className="mb-2 flex items-center">
						<h2 className="flex items-center gap-2 font-semibold">
							<Inbox className="size-4" /> Inbox
						</h2>
						<Button size="sm" variant="ghost" className="ml-auto" onClick={() => void refresh()} loading={loading}>
							<RefreshCw /> Refresh
						</Button>
					</div>
					{messages === null ? (
						<p className="text-sm text-muted-foreground">Loading…</p>
					) : messages.length === 0 ? (
						<Card className="p-6 text-center text-sm text-muted-foreground">{topics.length ? "No messages yet. Publish one to see it here." : "Add a topic to see its messages here."}</Card>
					) : (
						<div className="grid gap-2">
							{messages.map((m) => (
								<MessageCard key={m.id} m={m} now={now} />
							))}
						</div>
					)}
				</section>

				{!isIOS() && !isAndroid() && (
					<p className="text-center text-xs text-muted-foreground">On a phone? Open this page there: iPhone needs Safari → Share → Add to Home Screen; Android works in Chrome.</p>
				)}
			</div>
		</div>
	);
}
