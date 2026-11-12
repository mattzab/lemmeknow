import type { TopicInfo } from "@shared/types";
import { Globe, Hash, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { admin } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { PageHeader, Table, Td, Th, Tr } from "@/components/ui/page";
import { TableSkeleton } from "@/components/ui/skeleton";
import { SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { useApi, useDocumentTitle } from "@/lib/hooks";
import { ago } from "@/lib/format";
import { SendDialog } from "./SendDialog";

type Draft = { name: string; description: string; anon_read: boolean; anon_write: boolean };
const EMPTY: Draft = { name: "", description: "", anon_read: false, anon_write: false };

export function TopicsPage() {
	useDocumentTitle("Topics · Lemmeknow");
	const topics = useApi<TopicInfo[]>("/api/admin/topics", { refreshMs: 10_000 });
	const [edit, setEdit] = useState<{ draft: Draft; existing: boolean } | null>(null);
	const [send, setSend] = useState<string | null>(null);
	const { run, busy } = useAction();
	const confirm = useConfirm();
	const [err, setErr] = useState<string>();

	const save = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!edit) return;
		setErr(undefined);
		const d = edit.draft;
		const ok = await run(
			"save",
			async () => {
				try {
					return edit.existing
						? await admin.patch(`/topics/${encodeURIComponent(d.name)}`, { description: d.description, anon_read: d.anon_read, anon_write: d.anon_write })
						: await admin.post("/topics", d);
				} catch (e) {
					setErr((e as Error).message);
					throw e;
				}
			},
			edit.existing ? "Topic saved" : `Topic ${d.name} created`,
		);
		if (ok) {
			setEdit(null);
			void topics.reload();
		}
	};

	const remove = async (t: TopicInfo) => {
		if (!(await confirm({ title: `Delete topic "${t.name}"?`, description: "Cached messages are deleted. Tokens keep their grants, and publishing to the name again recreates it.", confirmLabel: "Delete", destructive: true }))) return;
		await run("del", () => admin.del(`/topics/${encodeURIComponent(t.name)}`), "Topic deleted");
		void topics.reload();
	};

	return (
		<>
			<PageHeader
				title="Topics"
				description="Topics are created when you add them here or on first publish. Access is granted per token; anonymous access is off unless you enable it on a topic."
				actions={
					<>
						<Button variant="outline" onClick={() => setSend("")}>
							<Send /> Send
						</Button>
						<Button onClick={() => (setErr(undefined), setEdit({ draft: EMPTY, existing: false }))}>
							<Plus /> New topic
						</Button>
					</>
				}
			/>
			{topics.error ? (
				<ErrorState error={topics.error} onRetry={() => void topics.reload()} />
			) : (
				<Card>
					{!topics.data ? (
						<TableSkeleton rows={4} cols={6} />
					) : topics.data.length === 0 ? (
						<EmptyState icon={Hash} title="No topics yet" action={<Button onClick={() => setEdit({ draft: EMPTY, existing: false })}><Plus /> New topic</Button>}>
							Create a topic, mint a token for it, then subscribe from the ntfy app.
						</EmptyState>
					) : (
						<Table>
							<thead className="border-b">
								<tr>
									<Th>Topic</Th>
									<Th>Subscribers</Th>
									<Th>Cached</Th>
									<Th>Published</Th>
									<Th>Last message</Th>
									<Th className="text-right">Actions</Th>
								</tr>
							</thead>
							<tbody>
								{topics.data.map((t) => (
									<Tr key={t.name}>
										<Td>
											<div className="flex items-center gap-2">
												<span className="font-mono text-sm font-medium">{t.name}</span>
												{(t.anon_read || t.anon_write) && (
													<Tooltip content={`Anonymous ${[t.anon_read && "read", t.anon_write && "write"].filter(Boolean).join(" + ")} allowed`}>
														<Badge className="border-amber-500/40 text-amber-600 dark:text-amber-400">
															<Globe className="size-3" /> public {t.anon_read && t.anon_write ? "rw" : t.anon_read ? "r" : "w"}
														</Badge>
													</Tooltip>
												)}
											</div>
											{t.description && <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>}
										</Td>
										<Td>
											<span className={t.subscribers ? "font-medium text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>{t.subscribers}</span>
										</Td>
										<Td className="tabular-nums">{t.cached}</Td>
										<Td className="tabular-nums">{t.message_count}</Td>
										<Td className="text-muted-foreground">{ago(t.last_message_at)}</Td>
										<Td className="text-right">
											<div className="inline-flex gap-1">
												<Tooltip content="Send a test message">
													<Button variant="ghost" size="icon-sm" onClick={() => setSend(t.name)}>
														<Send />
													</Button>
												</Tooltip>
												<Tooltip content="Edit">
													<Button
														variant="ghost"
														size="icon-sm"
														onClick={() => (setErr(undefined), setEdit({ draft: { name: t.name, description: t.description, anon_read: t.anon_read, anon_write: t.anon_write }, existing: true }))}
													>
														<Pencil />
													</Button>
												</Tooltip>
												<Tooltip content="Delete">
													<Button variant="ghost" size="icon-sm" onClick={() => void remove(t)} disabled={busy === "del"}>
														<Trash2 />
													</Button>
												</Tooltip>
											</div>
										</Td>
									</Tr>
								))}
							</tbody>
						</Table>
					)}
				</Card>
			)}

			<Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
				<DialogContent>
					{edit && (
						<form onSubmit={save} className="contents">
							<DialogHeader title={edit.existing ? `Edit ${edit.draft.name}` : "New topic"} />
							<DialogBody className="grid gap-4">
								<Field label="Name" htmlFor="topic-name" hint="Letters, digits, - and _ (max 64). Anyone who knows the name still needs a token." error={err}>
									<Input
										id="topic-name"
										value={edit.draft.name}
										disabled={edit.existing}
										onChange={(e) => setEdit({ ...edit, draft: { ...edit.draft, name: e.target.value } })}
										placeholder="backups"
										className="font-mono"
										required
									/>
								</Field>
								<Field label="Description" htmlFor="topic-desc">
									<Input id="topic-desc" value={edit.draft.description} onChange={(e) => setEdit({ ...edit, draft: { ...edit.draft, description: e.target.value } })} placeholder="Optional" />
								</Field>
								<div className="rounded-md border p-3">
									<SwitchRow
										label="Anonymous read"
										description="Anyone with the URL can subscribe without a token."
										checked={edit.draft.anon_read}
										onCheckedChange={(v) => setEdit({ ...edit, draft: { ...edit.draft, anon_read: v } })}
									/>
									<SwitchRow
										label="Anonymous write"
										description="Anyone with the URL can publish without a token."
										checked={edit.draft.anon_write}
										onCheckedChange={(v) => setEdit({ ...edit, draft: { ...edit.draft, anon_write: v } })}
									/>
								</div>
							</DialogBody>
							<DialogFooter>
								<Button variant="ghost" onClick={() => setEdit(null)}>
									Cancel
								</Button>
								<Button type="submit" loading={busy === "save"}>
									{edit.existing ? "Save" : "Create"}
								</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>

			<SendDialog
				open={send !== null}
				onOpenChange={(o) => !o && setSend(null)}
				topic={send || undefined}
				topics={topics.data?.map((t) => t.name) ?? []}
				onSent={() => void topics.reload()}
			/>
		</>
	);
}
