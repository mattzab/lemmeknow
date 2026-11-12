import { useEffect, useState } from "react";
import { admin } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { useAction } from "@/components/ui/toast";

/** Publish a message from the dashboard (goes through the same pipeline as the ntfy API). */
export function SendDialog({ open, onOpenChange, topic, topics, onSent }: { open: boolean; onOpenChange: (v: boolean) => void; topic?: string; topics: string[]; onSent?: () => void }) {
	const [form, setForm] = useState({ topic: topic ?? "", title: "", message: "", priority: "3", tags: "", click: "" });
	const { run, busy } = useAction();
	useEffect(() => {
		if (open) setForm((f) => ({ ...f, topic: topic ?? f.topic ?? topics[0] ?? "" }));
	}, [open, topic, topics]);
	const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const r = await run(
			"send",
			() => admin.post("/publish", { ...form, priority: Number(form.priority) }),
			`Sent to ${form.topic}`,
		);
		if (r) {
			setForm({ ...form, title: "", message: "" });
			onSent?.();
			onOpenChange(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form onSubmit={submit} className="contents">
					<DialogHeader title="Send a notification" description="Delivered to every subscriber of the topic, like a publish from curl." />
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
						<Field label="Message" htmlFor="send-message">
							<Textarea id="send-message" value={form.message} onChange={set("message")} rows={3} placeholder="Backup finished" />
						</Field>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="Priority" htmlFor="send-priority">
								<Select id="send-priority" value={form.priority} onChange={set("priority")}>
									<option value="1">1 · min</option>
									<option value="2">2 · low</option>
									<option value="3">3 · default</option>
									<option value="4">4 · high</option>
									<option value="5">5 · urgent</option>
								</Select>
							</Field>
							<Field label="Tags" htmlFor="send-tags" hint="Comma separated; emoji shortcodes work (warning, tada).">
								<Input id="send-tags" value={form.tags} onChange={set("tags")} placeholder="tada" />
							</Field>
						</div>
						<Field label="Click URL" htmlFor="send-click">
							<Input id="send-click" value={form.click} onChange={set("click")} placeholder="https://…" />
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
