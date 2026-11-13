import type { Grant, Role, TopicInfo, UserInfo } from "@shared/types";
import { Pencil, Plus, ShieldCheck, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { admin } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm";
import { CodeBlock } from "@/components/ui/copy";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { PageHeader, Table, Td, Th, Tr } from "@/components/ui/page";
import { TableSkeleton } from "@/components/ui/skeleton";
import { useAction } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { dateTime } from "@/lib/format";
import { useApi, useDocumentTitle } from "@/lib/hooks";
import { useServer } from "../App";
import { GrantsEditor, grantSummary } from "./TokensPage";

type Draft = { email: string; role: Role; grants: Grant[]; existing?: boolean };
const NEW: Draft = { email: "", role: "member", grants: [{ topic: "", read: true, write: false }] };

export function UsersPage() {
	useDocumentTitle("Users · Lemmeknow");
	const users = useApi<UserInfo[]>("/api/admin/users");
	const topics = useApi<TopicInfo[]>("/api/admin/topics");
	const server = useServer();
	const [edit, setEdit] = useState<Draft | null>(null);
	const [err, setErr] = useState<{ text: string; field?: string }>();
	const { run, busy } = useAction();
	const confirm = useConfirm();

	const save = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!edit) return;
		setErr(undefined);
		const body = { role: edit.role, grants: edit.grants.filter((g) => g.topic.trim()) };
		const ok = await run(
			"save",
			async () => {
				try {
					if (edit.existing) return await admin.patch(`/users/${encodeURIComponent(edit.email)}`, body);
					return await admin.post("/users", { email: edit.email, ...body });
				} catch (e) {
					setErr({ text: (e as Error).message, field: (e as { field?: string }).field });
					throw e;
				}
			},
			edit.existing ? "User updated" : `Added ${edit.email}. They can log in at ${server?.baseUrl ?? location.origin} now.`,
		);
		if (ok) {
			setEdit(null);
			void users.reload();
		}
	};

	const remove = async (u: UserInfo) => {
		if (
			!(await confirm({
				title: `Remove ${u.email}?`,
				description: "They can no longer log in, their tokens are revoked, and their phones stop getting notifications.",
				confirmLabel: "Remove",
				destructive: true,
			}))
		)
			return;
		await run("del", () => admin.del(`/users/${encodeURIComponent(u.email)}`), `Removed ${u.email}`);
		void users.reload();
	};

	return (
		<>
			<PageHeader
				title="Users"
				description="People who can log in to Lemmeknow with their e-mail (Cloudflare Access sends them a one-time code). Members get the web app with their own permanent token for the topics you grant; admins also get this dashboard. Anyone who can open the dashboard can see every token."
				actions={
					<Button onClick={() => (setErr(undefined), setEdit(NEW))}>
						<Plus /> Add user
					</Button>
				}
			/>
			{users.error ? (
				<ErrorState error={users.error} onRetry={() => void users.reload()} />
			) : (
				<Card>
					{!users.data ? (
						<TableSkeleton rows={2} cols={5} />
					) : users.data.length === 0 ? (
						<EmptyState icon={Users} title="Just you so far" action={<Button onClick={() => setEdit(NEW)}><Plus /> Add user</Button>}>
							Add someone by e-mail to let them log in on their phone.
						</EmptyState>
					) : (
						<Table>
							<thead className="border-b">
								<tr>
									<Th>E-mail</Th>
									<Th>Role</Th>
									<Th>Topics</Th>
									<Th>Tokens</Th>
									<Th>Added</Th>
									<Th className="text-right">Actions</Th>
								</tr>
							</thead>
							<tbody>
								{users.data.map((u) => {
									const self = u.email === server?.email;
									const owner = u.source === "config";
									return (
										<Tr key={u.email}>
											<Td className="font-medium">
												{u.email}
												{self && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
											</Td>
											<Td>
												{u.role === "admin" ? (
													<Badge className="border-primary/40 text-primary">
														<ShieldCheck className="size-3" /> {owner ? "owner" : "admin"}
													</Badge>
												) : (
													<Badge>member</Badge>
												)}
											</Td>
											<Td>
												{u.role === "admin" ? (
													<span className="text-xs text-muted-foreground">all topics</span>
												) : u.grants.length === 0 ? (
													<span className="text-xs text-muted-foreground">none</span>
												) : (
													<div className="flex flex-wrap gap-1">
														{u.grants.map((g) => (
															<Badge key={g.topic} className={g.write ? "border-primary/40 text-primary" : undefined}>
																<span className="font-mono">{g.topic}</span> · {grantSummary(g)}
															</Badge>
														))}
													</div>
												)}
											</Td>
											<Td className="text-muted-foreground">{u.tokens}</Td>
											<Td className="text-xs text-muted-foreground">{owner ? "adminEmails config" : `${u.created_at ? dateTime(u.created_at) : ""}${u.added_by ? ` by ${u.added_by}` : ""}`}</Td>
											<Td className="text-right">
												{!owner && !self && (
													<div className="inline-flex gap-1">
														<Tooltip content="Edit role and topics">
															<Button variant="ghost" size="icon-sm" onClick={() => (setErr(undefined), setEdit({ email: u.email, role: u.role, grants: u.grants, existing: true }))}>
																<Pencil />
															</Button>
														</Tooltip>
														<Tooltip content="Remove">
															<Button variant="ghost" size="icon-sm" onClick={() => void remove(u)}>
																<Trash2 />
															</Button>
														</Tooltip>
													</div>
												)}
											</Td>
										</Tr>
									);
								})}
							</tbody>
						</Table>
					)}
				</Card>
			)}

			{server && (
				<details className="mt-6 text-sm">
					<summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">How Cloudflare Access knows who is invited</summary>
					<div className="mt-3 grid max-w-3xl gap-3 text-muted-foreground">
						<p>
							Your Access application asks this Worker whether an e-mail is on this list (an <b>External Evaluation</b> rule). If added people get "access denied" after entering their code, add an
							Include rule of type External Evaluation to the application's policy with these URLs:
						</p>
						<CodeBlock code={`Evaluate URL: ${server.accessEvaluateUrl}\nKeys URL:     ${server.accessKeysUrl}`} />
						<p>Keep your own e-mail as an Include rule too, so you can always get in. Owners come from adminEmails in lemmeknow.config.json.</p>
					</div>
				</details>
			)}

			<Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
				<DialogContent wide>
					{edit && (
						<form onSubmit={save} className="contents">
							<DialogHeader title={edit.existing ? `Edit ${edit.email}` : "Add user"} description="They log in with this e-mail on the Lemmeknow app (Log in button) and get a one-time code by e-mail." />
							<DialogBody className="grid gap-4">
								{!edit.existing && (
									<Field label="E-mail" htmlFor="user-email" error={err?.field === "email" ? err.text : undefined}>
										<Input id="user-email" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} placeholder="friend@example.com" autoComplete="off" required />
									</Field>
								)}
								<Field label="Role" htmlFor="user-role">
									<Select id="user-role" value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value as Role })}>
										<option value="member">Member: the app and their own token</option>
										<option value="admin">Admin: everything, including this dashboard and all tokens</option>
									</Select>
								</Field>
								{edit.role === "member" && (
									<Field label="Topics" error={err && err.field !== "email" ? err.text : undefined}>
										<GrantsEditor grants={edit.grants} onChange={(grants) => setEdit({ ...edit, grants })} topics={topics.data?.map((t) => t.name) ?? []} />
									</Field>
								)}
								{err && !err.field && <p className="text-sm text-destructive">{err.text}</p>}
							</DialogBody>
							<DialogFooter>
								<Button variant="ghost" onClick={() => setEdit(null)}>
									Cancel
								</Button>
								<Button type="submit" loading={busy === "save"}>
									{edit.existing ? "Save" : "Add user"}
								</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
