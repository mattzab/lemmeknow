import { useEffect, useState } from "react";
import { admin } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { useAction } from "@/components/ui/toast";

type PushSummary = { devices: number; sent: number; gone: number; failed: number };

/** Send a test notification from the dashboard: stored in the inbox and pushed to every device on the topic. */
export function SendDialog({ open, onOpenChange, topic, topics, onSent }: { open: boolean; onOpenChange: (v: boolean) => void; topic?: string; topics: string[]; onSent?: () => void }) {
	const [form, setForm] = useState({ topic: topic ?? "", title: "Test from Lemmeknow", body: "", priority: "3", tags: "", url: "" });
	const { run, busy } = useAction();
	useEffect(() => {
		if (open) setForm((f) => ({ ...f, topic: topic ?? f.topic ?? topics[0] ?? "" }));
	}, [open, topic, topics]);
	const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const r = await run(
			"send",
			() => admin.post<{ push: PushSummary }>("/publish", { ...form, body: form.body || "Hello from the dashboard 👋", priority: Number(form.priority), wait: true }),
			(r) =>
				r.push.devices === 0
					? `Saved to ${form.topic}. No devices are subscribed yet.`
					: `Pushed to ${r.push.sent} of ${r.push.devices} device${r.push.devices === 1 ? "" : "s"}${r.push.failed ? ` (${r.push.failed} failed)` : ""}${r.push.gone ? `, removed ${r.push.gone} expired` : ""}.`,
		);
		if (r) {
			setForm({ ...form, body: "" });
			onSent?.();
			onOpenChange(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form onSubmit={submit} className="contents">
					<DialogHeader title="Send a notification" description="Stored in the topic's inbox and pushed to every subscribed device, exactly like a publish through the API." />
					<DialogBody className="grid gap-4">
						<Field label="Topic" htmlFor="send-topic">
							<Input id="send-topic" list="send-topics" value={form.topic} onChange={set("topic")} placeholder="alerts" required />
							<datalist id="send-topics">
								{topics.map((t) => (
									<option key={t} value={t} />
								))}
							</datalist>
						</Field>
						<Field label="Title" htmlFor="send-title">
							<Input id="send-title" value={form.title} onChange={set("title")} placeholder="Optional" />
						</Field>
						<Field label="Body" htmlFor="send-body">
							<Textarea id="send-body" value={form.body} onChange={set("body")} rows={3} placeholder="Hello from the dashboard 👋" />
						</Field>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="Priority" htmlFor="send-priority">
								<Select id="send-priority" value={form.priority} onChange={set("priority")}>
									<option value="1">1 · min (silent)</option>
									<option value="2">2 · low</option>
									<option value="3">3 · default</option>
									<option value="4">4 · high</option>
									<option value="5">5 · urgent</option>
								</Select>
							</Field>
							<Field label="Tags" htmlFor="send-tags" hint="Comma separated, shown in the inbox.">
								<Input id="send-tags" value={form.tags} onChange={set("tags")} placeholder="test" />
							</Field>
						</div>
						<Field label="Link" htmlFor="send-url" hint="Opened when the notification is tapped.">
							<Input id="send-url" value={form.url} onChange={set("url")} placeholder="https://…" />
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" loading={busy === "send"}>
							Send
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
