import type { Grant, TokenInfo, TopicInfo } from "@shared/types";
import { KeyRound, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { admin } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm";
import { CopyField } from "@/components/ui/copy";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { PageHeader, Table, Td, Th, Tr } from "@/components/ui/page";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/switch";
import { useAction } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { useApi, useDocumentTitle } from "@/lib/hooks";
import { ago, dateTime } from "@/lib/format";
import { useServer } from "../App";
import { AppInstructions } from "./SetupPage";

type Draft = { id?: string; label: string; grants: Grant[]; expires: string };
const NEW: Draft = { label: "", grants: [{ topic: "", read: true, write: false }], expires: "" };

export function grantSummary(g: Grant) {
	return g.read && g.write ? "read-write" : g.read ? "read" : "write";
}

function GrantsEditor({ grants, onChange, topics }: { grants: Grant[]; onChange: (g: Grant[]) => void; topics: string[] }) {
	const set = (i: number, patch: Partial<Grant>) => onChange(grants.map((g, j) => (j === i ? { ...g, ...patch } : g)));
	return (
		<div className="grid gap-2">
			{grants.map((g, i) => (
				<div key={i} className="flex items-center gap-2">
					<Input
						list="grant-topics"
						value={g.topic}
						onChange={(e) => set(i, { topic: e.target.value })}
						placeholder="topic or pattern, e.g. alerts_*"
						className="flex-1 font-mono"
						aria-label="Topic or pattern"
					/>
					<label className="flex items-center gap-1.5 text-sm">
						<Checkbox checked={g.read} onCheckedChange={(v) => set(i, { read: v === true })} /> read
					</label>
					<label className="flex items-center gap-1.5 text-sm">
						<Checkbox checked={g.write} onCheckedChange={(v) => set(i, { write: v === true })} /> write
					</label>
					<Button variant="ghost" size="icon-sm" onClick={() => onChange(grants.filter((_, j) => j !== i))} aria-label="Remove grant">
						<X />
					</Button>
				</div>
			))}
			<datalist id="grant-topics">
				<option value="*" />
				{topics.map((t) => (
					<option key={t} value={t} />
				))}
			</datalist>
			<div>
				<Button variant="outline" size="sm" onClick={() => onChange([...grants, { topic: "", read: true, write: false }])}>
					<Plus /> Add topic
				</Button>
			</div>
		</div>
	);
}

export function TokensPage() {
	useDocumentTitle("Tokens · Lemmeknow");
	const tokens = useApi<TokenInfo[]>("/api/admin/tokens");
	const topics = useApi<TopicInfo[]>("/api/admin/topics");
	const server = useServer();
	const [edit, setEdit] = useState<Draft | null>(null);
	const [created, setCreated] = useState<{ token: string; info: TokenInfo } | null>(null);
	const [err, setErr] = useState<string>();
	const { run, busy } = useAction();
	const confirm = useConfirm();

	const save = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!edit) return;
		setErr(undefined);
		const grants = edit.grants.filter((g) => g.topic.trim());
		const r = await run("save", async () => {
			try {
				if (edit.id) return await admin.patch(`/tokens/${edit.id}`, { label: edit.label, grants });
				return await admin.post<{ token: string; info: TokenInfo }>("/tokens", { label: edit.label, grants, expires_in_days: edit.expires ? Number(edit.expires) : null });
			} catch (e) {
				setErr((e as Error).message);
				throw e;
			}
		}, edit.id ? "Token updated" : undefined);
		if (r) {
			if (!edit.id) setCreated(r as { token: string; info: TokenInfo });
			setEdit(null);
			void tokens.reload();
		}
	};

	const revoke = async (t: TokenInfo) => {
		if (!(await confirm({ title: `Revoke "${t.label}"?`, description: "Apps and scripts using this token stop working immediately.", confirmLabel: "Revoke", destructive: true }))) return;
		await run("del", () => admin.del(`/tokens/${t.id}`), "Token revoked");
		void tokens.reload();
	};

	return (
		<>
			<PageHeader
				title="Tokens"
				description="Every publisher and subscriber authenticates with a token. Grant it read (subscribe) and/or write (publish) on topics or * patterns."
				actions={
					<Button onClick={() => (setErr(undefined), setEdit(NEW))}>
						<Plus /> New token
					</Button>
				}
			/>
			{tokens.error ? (
				<ErrorState error={tokens.error} onRetry={() => void tokens.reload()} />
			) : (
				<Card>
					{!tokens.data ? (
						<TableSkeleton rows={3} cols={5} />
					) : tokens.data.length === 0 ? (
						<EmptyState icon={KeyRound} title="No tokens yet" action={<Button onClick={() => setEdit(NEW)}><Plus /> New token</Button>}>
							Mint one token per phone or script so you can revoke them independently.
						</EmptyState>
					) : (
						<Table>
							<thead className="border-b">
								<tr>
									<Th>Name</Th>
									<Th>Token</Th>
									<Th>Grants</Th>
									<Th>Last used</Th>
									<Th>Expires</Th>
									<Th className="text-right">Actions</Th>
								</tr>
							</thead>
							<tbody>
								{tokens.data.map((t) => (
									<Tr key={t.id}>
										<Td className="font-medium">{t.label}</Td>
										<Td className="font-mono text-xs text-muted-foreground">{t.prefix}…</Td>
										<Td>
											<div className="flex flex-wrap gap-1">
												{t.grants.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
												{t.grants.map((g) => (
													<Badge key={g.topic} className={g.write ? "border-primary/40 text-primary" : undefined}>
														<span className="font-mono">{g.topic}</span> · {grantSummary(g)}
													</Badge>
												))}
											</div>
										</Td>
										<Td className="text-muted-foreground">{ago(t.last_used_at)}</Td>
										<Td className="text-muted-foreground">{t.expires_at ? dateTime(t.expires_at) : "never"}</Td>
										<Td className="text-right">
											<div className="inline-flex gap-1">
												<Tooltip content="Edit name and grants">
													<Button variant="ghost" size="icon-sm" onClick={() => (setErr(undefined), setEdit({ id: t.id, label: t.label, grants: t.grants, expires: "" }))}>
														<Pencil />
													</Button>
												</Tooltip>
												<Tooltip content="Revoke">
													<Button variant="ghost" size="icon-sm" onClick={() => void revoke(t)}>
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
				<DialogContent wide>
					{edit && (
						<form onSubmit={save} className="contents">
							<DialogHeader title={edit.id ? `Edit ${edit.label}` : "New token"} description="Topic patterns may use * (e.g. * for everything, home_* for a prefix)." />
							<DialogBody className="grid gap-4">
								<Field label="Name" htmlFor="tok-label" hint="Who or what uses it, e.g. Matt's iPhone or backup script.">
									<Input id="tok-label" value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} required />
								</Field>
								<Field label="Grants" error={err}>
									<GrantsEditor grants={edit.grants} onChange={(grants) => setEdit({ ...edit, grants })} topics={topics.data?.map((t) => t.name) ?? []} />
								</Field>
								{!edit.id && (
									<Field label="Expires" htmlFor="tok-exp">
										<Select id="tok-exp" value={edit.expires} onChange={(e) => setEdit({ ...edit, expires: e.target.value })}>
											<option value="">Never</option>
											<option value="7">In 7 days</option>
											<option value="30">In 30 days</option>
											<option value="90">In 90 days</option>
											<option value="365">In 1 year</option>
										</Select>
									</Field>
								)}
							</DialogBody>
							<DialogFooter>
								<Button variant="ghost" onClick={() => setEdit(null)}>
									Cancel
								</Button>
								<Button type="submit" loading={busy === "save"}>
									{edit.id ? "Save" : "Create token"}
								</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>

			<Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
				<DialogContent wide>
					{created && (
						<>
							<DialogHeader title={`Token for ${created.info.label}`} description="Copy it now. Only a hash is stored, so it cannot be shown again." />
							<DialogBody className="grid gap-4">
								<CopyField value={created.token} />
								<AppInstructions baseUrl={server?.baseUrl ?? location.origin} token={created.token} topic={created.info.grants[0]?.topic.includes("*") ? undefined : created.info.grants[0]?.topic} />
							</DialogBody>
							<DialogFooter>
								<Button onClick={() => setCreated(null)}>Done</Button>
							</DialogFooter>
						</>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
