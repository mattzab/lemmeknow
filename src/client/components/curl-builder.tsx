import type { Grant } from "@shared/types";
import { curlGet, curlPost, publishGetUrl, publishUrl } from "@shared/curl";
import { Check, Copy, Send, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CodeBlock, CopyField } from "@/components/ui/copy";
import { Field, Input, Select } from "@/components/ui/input";
import { cn, copyText } from "@/lib/utils";

/** A token the builder can put in the URL. */
export interface BuilderToken {
	id: string;
	label: string;
	token: string;
	grants: Grant[];
}

const match = (pattern: string, topic: string) => new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(topic);
export const canWrite = (t: BuilderToken, topic: string) => t.grants.some((g) => g.write && match(g.topic, topic));

type Mode = "post" | "get" | "url";
const MODES: { id: Mode; label: string; hint: string }[] = [
	{ id: "post", label: "curl", hint: "The message goes in the body, options in the URL. --retry 3 retries network errors (rarely, that can mean a duplicate)." },
	{ id: "get", label: "GET / cron", hint: "Everything in the URL, so a plain GET works: cron jobs, uptime monitors, Shortcuts, anything that can fetch a URL." },
	{ id: "url", label: "URL", hint: "Opening or fetching this URL publishes (GET, HEAD, POST or PUT). With no message it sends \"Ping\"." },
];

/** A big one-tap copy button (the CodeBlock corner button is small on a phone). */
function CopyBig({ value, label }: { value: string; label: string }) {
	const [done, setDone] = useState(false);
	return (
		<Button
			className="w-full sm:w-auto"
			onClick={async () => {
				if (await copyText(value)) {
					setDone(true);
					setTimeout(() => setDone(false), 1500);
				}
			}}
		>
			{done ? <Check /> : <Copy />} {done ? "Copied" : label}
		</Button>
	);
}

/**
 * Pick a topic and token, fill in the message, get a copy-ready curl for the short publish URL
 * (`<base>/<token>/<topic>`). Used by the dashboard's Curl page and the web app.
 */
export function CurlBuilder({
	baseUrl,
	topics,
	tokens,
	preferTokenId,
	compact,
}: {
	baseUrl: string;
	topics: string[];
	tokens: BuilderToken[];
	/** Chosen by default when it can write to the topic (the signed-in person's personal token). */
	preferTokenId?: string;
	/** Fewer fields, for the phone app. */
	compact?: boolean;
}) {
	const [topic, setTopic] = useState(topics[0] ?? "");
	const writers = useMemo(() => tokens.filter((t) => topic && canWrite(t, topic)), [tokens, topic]);
	const [tokenId, setTokenId] = useState<string>("");
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("Nightly backup finished");
	const [url, setUrl] = useState("");
	const [priority, setPriority] = useState("3");
	const [mode, setMode] = useState<Mode>("post");
	const [sent, setSent] = useState<{ ok: boolean; text: string } | null>(null);
	const [sending, setSending] = useState(false);

	useEffect(() => {
		if (!topic && topics[0]) setTopic(topics[0]);
	}, [topics, topic]);
	// Keep the chosen token valid for the topic; prefer the personal token.
	useEffect(() => {
		if (writers.some((t) => t.id === tokenId)) return;
		setTokenId((writers.find((t) => t.id === preferTokenId) ?? writers[0])?.id ?? "");
	}, [writers, tokenId, preferTokenId]);

	const tok = writers.find((t) => t.id === tokenId);
	const opts = { title, body, url, priority };
	const cmd = tok ? (mode === "post" ? curlPost(baseUrl, tok.token, topic, opts) : mode === "get" ? curlGet(baseUrl, tok.token, topic, opts) : publishGetUrl(baseUrl, tok.token, topic, opts)) : "";

	async function sendNow() {
		if (!tok) return;
		setSending(true);
		setSent(null);
		try {
			const res = await fetch(publishUrl(baseUrl, tok.token, topic) + new URL(publishGetUrl(baseUrl, tok.token, topic, { title, url, priority })).search, { method: "POST", body: body.trim(), headers: { "content-type": "text/plain" } });
			const data = (await res.json().catch(() => ({}))) as { devices?: number; error?: string };
			setSent(res.ok ? { ok: true, text: `Sent to ${data.devices ?? 0} device${data.devices === 1 ? "" : "s"}.` } : { ok: false, text: data.error ?? `HTTP ${res.status}` });
		} catch (e) {
			setSent({ ok: false, text: (e as Error).message });
		} finally {
			setSending(false);
		}
	}

	if (!topics.length) return <p className="text-sm text-muted-foreground">No topics yet. Create a topic first, then come back here for its command.</p>;

	return (
		<div className="grid grid-cols-[minmax(0,1fr)] gap-4">
			<div className={cn("grid gap-3", !compact && "sm:grid-cols-2")}>
				<Field label="Topic" htmlFor="cb-topic">
					<Select id="cb-topic" value={topic} onChange={(e) => setTopic(e.target.value)} className="font-mono">
						{topics.map((t) => (
							<option key={t} value={t}>
								{t}
							</option>
						))}
					</Select>
				</Field>
				{!compact && (
					<Field label="Token" htmlFor="cb-token" hint={writers.length ? "Only tokens that can write to this topic are listed." : undefined}>
						<Select id="cb-token" value={tokenId} onChange={(e) => setTokenId(e.target.value)} disabled={!writers.length}>
							{writers.length === 0 && <option value="">No copyable token can write here</option>}
							{writers.map((t) => (
								<option key={t.id} value={t.id}>
									{t.label}
								</option>
							))}
						</Select>
					</Field>
				)}
				<Field label="Message" htmlFor="cb-body" hint={compact ? undefined : "Optional. Empty sends \"Ping\"."}>
					<Input id="cb-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Ping" />
				</Field>
				<Field label="Title" htmlFor="cb-title">
					<Input id="cb-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" />
				</Field>
				{!compact && (
					<>
						<Field label="Link (opened on tap)" htmlFor="cb-url">
							<Input id="cb-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (optional)" />
						</Field>
						<Field label="Priority" htmlFor="cb-prio">
							<Select id="cb-prio" value={priority} onChange={(e) => setPriority(e.target.value)}>
								<option value="1">1 · silent</option>
								<option value="2">2 · low</option>
								<option value="3">3 · normal</option>
								<option value="4">4 · high</option>
								<option value="5">5 · urgent (stays on screen)</option>
							</Select>
						</Field>
					</>
				)}
			</div>

			{!tok ? (
				<p className="flex items-start gap-2 rounded-md border border-amber-500/40 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
					<TriangleAlert className="mt-0.5 size-4 shrink-0" />
					{compact ? "Your token cannot write to this topic. Ask an admin for write access." : "No token with a copyable value can write to this topic. Make one on the Tokens page (or Replace an old one)."}
				</p>
			) : (
				<>
					<div className="flex gap-1 rounded-lg border bg-muted/30 p-1" role="tablist">
						{MODES.map((m) => (
							<button
								key={m.id}
								type="button"
								role="tab"
								aria-selected={mode === m.id}
								onClick={() => setMode(m.id)}
								className={cn("flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors", mode === m.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
							>
								{m.label}
							</button>
						))}
					</div>
					{mode === "url" ? <CopyField value={cmd} /> : <CodeBlock code={cmd} preClassName="whitespace-pre-wrap break-all" />}
					<p className="-mt-2 text-xs text-muted-foreground">{MODES.find((m) => m.id === mode)?.hint}</p>
					<div className="flex flex-wrap items-center gap-2">
						<CopyBig value={cmd} label={mode === "url" ? "Copy URL" : "Copy command"} />
						<Button variant="outline" className="w-full sm:w-auto" loading={sending} onClick={() => void sendNow()}>
							<Send /> Send it now
						</Button>
						{sent && (
							<span className={cn("flex items-center gap-1 text-sm", sent.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
								{sent.ok ? <Check className="size-4" /> : <TriangleAlert className="size-4" />} {sent.text}
							</span>
						)}
					</div>
					<p className="text-xs text-muted-foreground">The token is part of the URL, so it can end up in shell history, cron logs and proxy logs. Use a token that only writes to the topics it needs, and revoke it if it leaks.</p>
				</>
			)}
		</div>
	);
}
