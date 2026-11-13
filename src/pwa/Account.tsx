import type { MeInfo } from "@shared/types";
import { Check, KeyRound, LayoutDashboard, LogIn, LogOut, Plus, RefreshCw, Smartphone, UserRound, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { Input } from "@/components/ui/input";
import { api, ApiError, isIOS, isStandalone } from "./push";

/** Small header control: "Log in" when signed out, the e-mail when signed in. */
export function AccountChip({ account, open, onToggle }: { account: MeInfo | null; open: boolean; onToggle: () => void }) {
	if (!account) {
		return (
			<Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onToggle} aria-expanded={open}>
				<LogIn className="size-3.5" /> Log in
			</Button>
		);
	}
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={open}
			title={`Signed in as ${account.email}`}
			className="inline-flex max-w-[11rem] items-center gap-1 rounded-full border border-primary/40 px-2 py-0.5 text-xs text-primary hover:bg-primary/10"
		>
			<UserRound className="size-3 shrink-0" />
			<span className="truncate">{account.email.split("@")[0]}</span>
		</button>
	);
}

/** Signed out: start the Cloudflare Access e-mail login, or type a code from Safari (Home Screen app). */
export function LoginCard({ onPaired, onClose }: { onPaired: (me: MeInfo) => void; onClose: () => void }) {
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const homeScreenIOS = isIOS() && isStandalone();
	return (
		<Card className="relative p-5">
			<button type="button" className="absolute right-3 top-3 text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close">
				<X className="size-4" />
			</button>
			<h2 className="font-semibold">Log in</h2>
			<p className="mt-1 text-sm text-muted-foreground">We e-mail you a one-time code. Once in, your topics and your token are right here on this device.</p>
			<Button className="mt-4 w-full" onClick={() => (location.href = "/login")}>
				<LogIn /> Log in with e-mail
			</Button>
			<details className="mt-4" open={homeScreenIOS}>
				<summary className="cursor-pointer list-none text-sm font-medium text-primary">Logged in with Safari instead? Enter its code</summary>
				<p className="mt-2 text-xs text-muted-foreground">
					The Home Screen app keeps its own sign-in. If the login finished in Safari, open Lemmeknow there, tap your name → <b>Code for Home Screen app</b>, and type the code here.
				</p>
				<form
					className="mt-3 flex gap-2"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						setErr(null);
						try {
							onPaired(await api.pair(code));
						} catch (e) {
							setErr((e as Error).message);
						} finally {
							setBusy(false);
						}
					}}
				>
					<Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-2345" autoCapitalize="characters" autoCorrect="off" spellCheck={false} className="font-mono uppercase" />
					<Button type="submit" variant="outline" loading={busy} disabled={code.replace(/[^a-z0-9]/gi, "").length < 8}>
						Sign in
					</Button>
				</form>
				{err && <p className="mt-2 text-xs text-destructive">{err}</p>}
			</details>
		</Card>
	);
}

/** Signed in: who you are, your permanent token, your topics, and logout. */
export function AccountCard({
	account,
	session,
	onDevice,
	busy,
	onAddTopic,
	onRotated,
	onLogout,
	onClose,
}: {
	account: MeInfo;
	/** Signed in through the Access cookie here (false: paired with a code). */
	session: boolean;
	onDevice: Set<string>;
	busy: string | null;
	onAddTopic: (topic: string) => void;
	onRotated: (me: MeInfo) => void;
	onLogout: () => void;
	onClose: () => void;
}) {
	const [pair, setPair] = useState<{ code: string; expires_at: number } | null>(null);
	const [working, setWorking] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const safariIOS = isIOS() && !isStandalone();

	const run = async (what: string, fn: () => Promise<void>) => {
		setWorking(what);
		setErr(null);
		try {
			await fn();
		} catch (e) {
			setErr(e instanceof ApiError && (e.status === 0 || e.status === 401) ? "Your login expired: log in again to do this." : (e as Error).message);
		} finally {
			setWorking(null);
		}
	};

	return (
		<Card className="relative p-5">
			<button type="button" className="absolute right-3 top-3 text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close">
				<X className="size-4" />
			</button>
			<div className="flex items-center gap-2 pr-6">
				<UserRound className="size-4 shrink-0 text-primary" />
				<span className="min-w-0 truncate text-sm font-medium">{account.email}</span>
				<Badge>{account.role}</Badge>
			</div>

			<div className="mt-4">
				<div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					<KeyRound className="size-3.5" /> Your token (for curl and scripts, never expires)
				</div>
				<CopyField value={account.token} secret />
				{session && (
					<button
						type="button"
						className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
						disabled={working === "rotate"}
						onClick={() =>
							confirm("Make a new token? The old one stops working right away (this device stays subscribed).") &&
							void run("rotate", async () => onRotated(await api.rotate()))
						}
					>
						<RefreshCw className="size-3" /> New token
					</button>
				)}
			</div>

			<div className="mt-4">
				<div className="mb-1 text-xs font-medium text-muted-foreground">Your topics</div>
				{account.topics.length === 0 ? (
					<p className="text-sm text-muted-foreground">None yet. {account.role === "admin" ? "Create one in the dashboard." : "Ask an admin to give you a topic."}</p>
				) : (
					<ul className="divide-y rounded-md border">
						{account.topics.map((t) => (
							<li key={t.name} className="flex items-center gap-2 px-3 py-1.5">
								<span className="min-w-0 flex-1 truncate font-mono text-sm" title={t.description || undefined}>
									{t.name}
								</span>
								{onDevice.has(t.name) ? (
									<Check className="size-4 text-emerald-500" aria-label="On this device" />
								) : (
									<Button size="sm" variant="outline" className="h-7" loading={busy === "add"} onClick={() => onAddTopic(t.name)}>
										<Plus /> Add
									</Button>
								)}
							</li>
						))}
					</ul>
				)}
			</div>

			{session && safariIOS && (
				<div className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
					<div className="flex items-center gap-1.5 font-medium">
						<Smartphone className="size-4 text-primary" /> Code for Home Screen app
					</div>
					<p className="mt-1 text-xs text-muted-foreground">Notifications need the Home Screen app, which has its own login. Open it, tap Log in, and enter this code.</p>
					{pair ? (
						<p className="mt-2 font-mono text-2xl font-semibold tracking-widest">{pair.code}</p>
					) : (
						<Button size="sm" className="mt-2" loading={working === "pair"} onClick={() => void run("pair", async () => setPair(await api.pairCode()))}>
							Get a code
						</Button>
					)}
					{pair && <p className="mt-1 text-xs text-muted-foreground">Works once, for 10 minutes.</p>}
				</div>
			)}

			{err && <p className="mt-3 text-xs text-destructive">{err}</p>}

			<div className="mt-4 flex flex-wrap gap-2">
				{account.role === "admin" && (
					<Button size="sm" variant="outline" onClick={() => (location.href = "/admin")}>
						<LayoutDashboard /> Dashboard
					</Button>
				)}
				<Button size="sm" variant="ghost" className="ml-auto" onClick={onLogout}>
					<LogOut /> Log out
				</Button>
			</div>
		</Card>
	);
}
