import type { Message, TopicInfo } from "@shared/types";
import { ExternalLink, MessagesSquare, Send } from "lucide-react";
import { useState } from "react";
import { Badge, TagChip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page";
import { CardsSkeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { ago, dateTime, PRIORITY_LABEL } from "@/lib/format";
import { useApi, useDocumentTitle, useNow } from "@/lib/hooks";
import { useServer } from "../App";
import { SendDialog } from "./SendDialog";

const PRIO_CLS: Record<number, string> = {
	1: "text-muted-foreground",
	2: "text-muted-foreground",
	4: "border-amber-500/40 text-amber-600 dark:text-amber-400",
	5: "border-red-500/40 text-red-600 dark:text-red-400",
};

export function MessagesPage() {
	useDocumentTitle("Messages · Lemmeknow");
	const server = useServer();
	const [topic, setTopic] = useState("");
	const [send, setSend] = useState(false);
	const topics = useApi<TopicInfo[]>("/api/admin/topics");
	const msgs = useApi<Message[]>(`/api/admin/messages?limit=200${topic ? `&topic=${encodeURIComponent(topic)}` : ""}`, { refreshMs: 5_000 });
	const now = useNow(15_000);

	return (
		<>
			<PageHeader
				title="Messages"
				description="Everything still in the inbox, across topics. Messages expire automatically after the retention period."
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
					<EmptyState icon={MessagesSquare} title="No messages">
						Publish with{" "}
						<code className="font-mono text-xs">
							curl -H "Authorization: Bearer lk_…" -d "hi" {server?.baseUrl ?? location.origin}/api/v1/topics/{topic || "alerts"}/messages
						</code>{" "}
						or use Send.
					</EmptyState>
				</Card>
			) : (
				<div className="grid gap-2">
					{msgs.data.map((m) => (
						<Card key={m.id} className="p-4">
							<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								<span className="font-mono font-medium text-foreground">{m.topic}</span>
								<Tooltip content={dateTime(m.time)}>
									<span>{ago(m.time, now)}</span>
								</Tooltip>
								{m.priority !== 3 ? <Badge className={PRIO_CLS[m.priority]}>{PRIORITY_LABEL[m.priority]}</Badge> : null}
								{m.tags?.map((t) => <TagChip key={t} tag={t} />)}
								<span className="ml-auto font-mono">{m.id}</span>
							</div>
							{m.title && <p className="mt-2 font-semibold">{m.title}</p>}
							{m.body && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{m.body}</p>}
							{m.url && (
								<a href={m.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
									<ExternalLink className="size-3" /> {m.url}
								</a>
							)}
						</Card>
					))}
				</div>
			)}
			<SendDialog open={send} onOpenChange={setSend} topic={topic || undefined} topics={topics.data?.map((t) => t.name) ?? []} onSent={() => void msgs.reload()} />
		</>
	);
}
