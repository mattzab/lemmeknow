import { Apple, Smartphone, Terminal } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock, CopyField } from "@/components/ui/copy";
import { PageHeader } from "@/components/ui/page";
import { span } from "@/lib/format";
import { useDocumentTitle } from "@/lib/hooks";
import { curlGet, curlPost } from "@shared/curl";
import { Link } from "wouter";
import { useServer } from "../App";

/** Phone setup for the Lemmeknow web app, with this deployment's URL filled in. */
export function PhoneInstructions({ baseUrl, topic }: { baseUrl: string; topic?: string }) {
	const t = topic ?? "your topic";
	return (
		<div className="grid gap-4 text-sm">
			<div className="grid gap-1.5">
				<p className="font-medium">App URL (open it on the phone)</p>
				<CopyField value={`${baseUrl}/`} />
			</div>
			<div className="grid gap-1">
				<p className="flex items-center gap-1.5 font-medium">
					<Apple className="size-4" /> iPhone (iOS 16.4 or later)
				</p>
				<ol className="ml-5 list-decimal space-y-0.5 text-muted-foreground">
					<li>Open the app URL in Safari.</li>
					<li>Share → Add to Home Screen → Add.</li>
					<li>Open Lemmeknow from the Home Screen icon (not from Safari).</li>
					<li>
						Add a topic: <code className="font-mono">{t}</code> and the token, tap Subscribe, then Allow notifications.
					</li>
				</ol>
				<p className="text-xs text-muted-foreground">The Home Screen app has its own storage, so paste the token inside the app, not in Safari.</p>
			</div>
			<div className="grid gap-1">
				<p className="flex items-center gap-1.5 font-medium">
					<Smartphone className="size-4" /> Android (Chrome)
				</p>
				<ol className="ml-5 list-decimal space-y-0.5 text-muted-foreground">
					<li>Open the app URL in Chrome. Optionally ⋮ → Add to Home screen → Install.</li>
					<li>
						Add a topic: <code className="font-mono">{t}</code> and the token, tap Subscribe, then Allow.
					</li>
				</ol>
			</div>
		</div>
	);
}

export function CurlExamples({ baseUrl, token, topic }: { baseUrl: string; token?: string; topic?: string }) {
	const tk = token ?? "lk_your_token";
	const t = topic ?? "alerts";
	const api = `${baseUrl}/api/v1/topics/${t}/messages`;
	return (
		<div className="grid gap-3">
			<CodeBlock
				code={[
					`# publish: the token and topic are in the URL`,
					curlPost(baseUrl, tk, t, { body: "Nightly backup finished", title: "Backup" }),
					``,
					`# GET only (cron, uptime monitors): everything in the URL`,
					curlGet(baseUrl, tk, t, { body: "Disk is 90% full", priority: 4 }),
				].join("\n")}
				preClassName="whitespace-pre-wrap break-all"
			/>
			<details className="text-sm">
				<summary className="cursor-pointer text-muted-foreground hover:text-foreground">Header API (keeps the token out of URLs and logs)</summary>
				<CodeBlock
					className="mt-2"
					preClassName="whitespace-pre-wrap break-all"
					code={[
						`# publish (JSON)`,
						`curl -X POST ${api} \\`,
						`  -H "Authorization: Bearer ${tk}" -H "Content-Type: application/json" \\`,
						`  -d '{"title":"Backup","body":"Nightly backup finished","priority":3,"url":"https://example.com"}'`,
						``,
						`# read the inbox (newest first)`,
						`curl -H "Authorization: Bearer ${tk}" "${api}?limit=20"`,
					].join("\n")}
				/>
			</details>
		</div>
	);
}

export function ConnectPage() {
	useDocumentTitle("Connect · Lemmeknow");
	const server = useServer();
	const base = server?.baseUrl ?? location.origin;
	return (
		<>
			<PageHeader title="Connect" description="Install the Lemmeknow web app on phones and publish from scripts. Mint tokens on the Tokens page first." />
			<div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
				<Card>
					<CardHeader>
						<CardTitle>Phones</CardTitle>
						<CardDescription>Notifications use Web Push from this deployment. No app store, no third-party relay.</CardDescription>
					</CardHeader>
					<CardContent>
						<PhoneInstructions baseUrl={base} />
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-1.5">
							<Terminal className="size-4" /> Publish API
						</CardTitle>
						<CardDescription>
							Any tool that can make an HTTP request can notify you. Messages stay in the inbox for {span(server?.retentionSeconds ?? 0)}.
						</CardDescription>
					</CardHeader>
					<CardContent className="grid grid-cols-[minmax(0,1fr)] gap-4 text-sm">
						<p>
							Build one with your real token and topic on the{" "}
							<Link href="/curl" className="font-medium text-primary hover:underline">
								Curl page
							</Link>
							.
						</p>
						<CurlExamples baseUrl={base} />
						<div className="grid gap-1 text-muted-foreground">
							<p>
								<span className="font-medium text-foreground">Fields:</span> <code className="font-mono">body</code> (≤ 4000 chars; the request body or a query parameter, "Ping" if empty), <code className="font-mono">title</code>,{" "}
								<code className="font-mono">url</code> (opened on tap), <code className="font-mono">priority</code> 1–5 (4–5 send as high urgency),{" "}
								<code className="font-mono">tags</code>.
							</p>
							<p>
								<span className="font-medium text-foreground">Responses:</span> <code className="font-mono">201 {"{ ok, id, topic, devices }"}</code>; errors are{" "}
								<code className="font-mono">{"{ error, field? }"}</code> with 400, 401 (bad token) or 403 (no grant).
							</p>
						</div>
					</CardContent>
				</Card>
			</div>
		</>
	);
}
