import { Apple, Smartphone, Terminal } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock, CopyField } from "@/components/ui/copy";
import { PageHeader } from "@/components/ui/page";
import { useDocumentTitle } from "@/lib/hooks";
import { span } from "@/lib/format";
import { useServer } from "../App";

/** Step-by-step setup for the official ntfy apps and curl, with real values filled in. */
export function AppInstructions({ baseUrl, token, topic }: { baseUrl: string; token?: string; topic?: string }) {
	const tk = token ?? "tk_your_token";
	const t = topic ?? "mytopic";
	return (
		<div className="grid gap-4 text-sm">
			<div className="grid gap-1.5">
				<p className="font-medium">Server URL</p>
				<CopyField value={baseUrl} />
			</div>
			<div className="grid gap-1">
				<p className="flex items-center gap-1.5 font-medium">
					<Apple className="size-4" /> iPhone (ntfy for iOS)
				</p>
				<ol className="ml-5 list-decimal space-y-0.5 text-muted-foreground">
					<li>Settings → Users → Add user. Service URL: the server URL above.</li>
					<li>Username: anything (e.g. <code className="font-mono">lemmeknow</code>). Password: the token.</li>
					<li>Settings → Default server: the server URL (optional, saves typing).</li>
					<li>
						Tap + → topic <code className="font-mono">{t}</code> → "Use another server" → the server URL.
					</li>
				</ol>
			</div>
			<div className="grid gap-1">
				<p className="flex items-center gap-1.5 font-medium">
					<Smartphone className="size-4" /> Android (ntfy from Play Store or F-Droid)
				</p>
				<ol className="ml-5 list-decimal space-y-0.5 text-muted-foreground">
					<li>Settings → Manage users → Add user: server URL above, any username, token as password.</li>
					<li>
						+ → topic <code className="font-mono">{t}</code> → "Use another server" → the server URL. Enable "instant delivery" for background
						notifications.
					</li>
					<li>Settings → Connection protocol → WebSockets is the most efficient choice for Lemmeknow.</li>
				</ol>
			</div>
			<div className="grid gap-1.5">
				<p className="flex items-center gap-1.5 font-medium">
					<Terminal className="size-4" /> curl
				</p>
				<CodeBlock
					code={[
						`# publish`,
						`curl -H "Authorization: Bearer ${tk}" -H "Title: Hello" -d "Backup done" ${baseUrl}/${t}`,
						``,
						`# subscribe (stream)`,
						`curl -s -H "Authorization: Bearer ${tk}" ${baseUrl}/${t}/json`,
						``,
						`# poll cached messages and exit`,
						`curl -s -H "Authorization: Bearer ${tk}" "${baseUrl}/${t}/json?poll=1&since=1h"`,
					].join("\n")}
				/>
			</div>
		</div>
	);
}

export function SetupPage() {
	useDocumentTitle("App setup · Lemmeknow");
	const server = useServer();
	const baseUrl = server?.baseUrl ?? location.origin;
	return (
		<>
			<PageHeader title="App setup" description="Point the official ntfy apps and your scripts at this server." />
			<div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
				<Card>
					<CardHeader>
						<CardTitle>Connect a device</CardTitle>
						<CardDescription>Mint a token on the Tokens page first; this page shows placeholders.</CardDescription>
					</CardHeader>
					<CardContent>
						<AppInstructions baseUrl={baseUrl} />
					</CardContent>
				</Card>
				<div className="grid content-start gap-4">
					<Card>
						<CardHeader>
							<CardTitle>iOS background delivery</CardTitle>
						</CardHeader>
						<CardContent className="grid gap-2 text-sm text-muted-foreground">
							{server?.upstreamEnabled ? (
								<>
									<p>
										After each publish Lemmeknow sends an empty <code className="font-mono">poll_request</code> to{" "}
										<code className="font-mono">{server.upstreamBaseUrl}</code> on a SHA-256 hash of the topic URL. Apple's push wakes the iOS app, which then
										fetches the message from this server.
									</p>
									<p>Message content never leaves Lemmeknow. The upstream only sees the hash and the message ID.</p>
								</>
							) : (
								<p>Upstream wakeups are disabled, so iOS only receives messages while the app is open. Set upstreamBaseUrl to enable background delivery.</p>
							)}
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>This server</CardTitle>
						</CardHeader>
						<CardContent className="grid gap-1 text-sm">
							<p className="flex justify-between gap-2">
								<span className="text-muted-foreground">Message cache</span> <span>{server ? span(server.cacheDurationSeconds) : "…"}</span>
							</p>
							<p className="flex justify-between gap-2">
								<span className="text-muted-foreground">Version</span> <span>{server?.version ?? "…"}</span>
							</p>
						</CardContent>
					</Card>
				</div>
			</div>
		</>
	);
}
