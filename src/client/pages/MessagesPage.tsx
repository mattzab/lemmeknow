import type { NtfyMessage, TopicInfo } from "@shared/types";
import { Clock, ExternalLink, MessagesSquare, Paperclip, Send } from "lucide-react";
import { useState } from "react";
import { Badge, TagChip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page";
import { CardsSkeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useApi, useDocumentTitle, useNow } from "@/lib/hooks";
import { ago, dateTime, PRIORITY_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SendDialog } from "./SendDialog";

type Row = NtfyMessage & { published: boolean };

const PRIO_CLS: Record<number, string> = {
	1: "text-muted-foreground",
	2: "text-muted-foreground",
	4: "border-amber-500/40 text-amber-600 dark:text-amber-400",
	5: "border-red-500/40 text-red-600 dark:text-red-400",
};

export function MessagesPage() {
	useDocumentTitle("Messages · Lemmeknow");
	const [topic, setTopic] = useState("");
	const [send, setSend] = useState(false);
	const topics = useApi<TopicInfo[]>("/api/admin/topics");
	const msgs = useApi<Row[]>(`/api/admin/messages?limit=200${topic ? `&topic=${encodeURIComponent(topic)}` : ""}`, { refreshMs: 5_000 });
	const now = useNow(15_000);

	return (
		<>
			<PageHeader
				title="Messages"
				description="Recent messages still in the cache (what apps can poll). Expired messages are pruned automatically."
				actions={
					<>
						<Select value={topic} onChange={(e) => setTopic(e.target.value)} className="w-44">
							<option value="">All topics</option>
							{topics.data?.map((t) => (
								<option key={t.name} value={t.name}>
									{t.name}
								</option>
							))}
						</Select>
						<Button onClick={() => setSend(true)}>
							<Send /> Send
						</Button>
					</>
				}
			/>
			{msgs.error ? (
				<ErrorState error={msgs.error} onRetry={() => void msgs.reload()} />
			) : !msgs.data ? (
				<CardsSkeleton count={4} className="grid-cols-1" />
			) : msgs.data.length === 0 ? (
				<Card>
					<EmptyState icon={MessagesSquare} title="No cached messages">
						Publish with <code className="font-mono text-xs">curl -d "hi" -H "Authorization: Bearer tk_…" {location.origin}/topic</code> or use Send.
					</EmptyState>
				</Card>
			) : (
				<div className="grid gap-2">
					{msgs.data.map((m) => (
						<Card key={m.id} className={cn("p-4", !m.published && "border-dashed")}>
							<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								<span className="font-mono font-medium text-foreground">{m.topic}</span>
								<Tooltip content={dateTime(m.time)}>
									<span>{ago(m.time, now)}</span>
								</Tooltip>
								{!m.published && (
									<Badge>
										<Clock className="size-3" /> scheduled
									</Badge>
								)}
								{m.priority && m.priority !== 3 ? <Badge className={PRIO_CLS[m.priority]}>{PRIORITY_LABEL[m.priority]}</Badge> : null}
								{m.tags?.map((t) => <TagChip key={t} tag={t} />)}
								<span className="ml-auto font-mono">{m.id}</span>
							</div>
							{m.title && <p className="mt-2 font-semibold">{m.title}</p>}
							<p className="mt-1 whitespace-pre-wrap break-words text-sm">{m.message}</p>
							{(m.click || m.attachment || m.actions?.length) && (
								<div className="mt-2 flex flex-wrap gap-2 text-xs">
									{m.click && (
										<a href={m.click} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
											<ExternalLink className="size-3" /> {m.click}
										</a>
									)}
									{m.attachment && (
										<a href={m.attachment.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
											<Paperclip className="size-3" /> {m.attachment.name}
										</a>
									)}
									{m.actions?.map((a) => (
										<Badge key={a.id}>
											{a.action}: {a.label}
										</Badge>
									))}
								</div>
							)}
						</Card>
					))}
				</div>
			)}
			<SendDialog open={send} onOpenChange={setSend} topic={topic || undefined} topics={topics.data?.map((t) => t.name) ?? []} onSent={() => void msgs.reload()} />
		</>
	);
}
