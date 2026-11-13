import type { TokenInfo, TopicInfo } from "@shared/types";
import { Terminal } from "lucide-react";
import { useMemo } from "react";
import { type BuilderToken, CurlBuilder } from "@/components/curl-builder";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page";
import { useApi, useDocumentTitle } from "@/lib/hooks";
import { useServer } from "../App";

/** Build the short publish URL and a copy-ready curl for it. */
export function CurlPage() {
	useDocumentTitle("Curl · Lemmeknow");
	const server = useServer();
	const topics = useApi<TopicInfo[]>("/api/admin/topics");
	const tokens = useApi<TokenInfo[]>("/api/admin/tokens");
	const usable = useMemo<BuilderToken[]>(
		() =>
			(tokens.data ?? [])
				.filter((t): t is TokenInfo & { token: string } => !!t.token)
				.map((t) => ({ id: t.id, label: t.personal ? `${t.label}` : t.label, token: t.token, grants: t.grants })),
		[tokens.data],
	);
	const mine = tokens.data?.find((t) => t.personal && t.user_email === server?.email)?.id;
	const base = server?.baseUrl ?? location.origin;
	return (
		<>
			<PageHeader
				title="Curl"
				description="Pick a topic and a token: you get a URL that publishes when anything fetches it, and a curl command ready to paste into a script or cron job."
			/>
			{topics.error || tokens.error ? (
				<ErrorState error={(topics.error ?? tokens.error)!} onRetry={() => (void topics.reload(), void tokens.reload())} />
			) : (
				<Card className="max-w-3xl">
					<CardHeader>
						<CardTitle className="flex items-center gap-1.5">
							<Terminal className="size-4" /> Publish URL
						</CardTitle>
						<CardDescription>
							<code className="font-mono">{base}/&lt;token&gt;/&lt;topic&gt;</code> · options as query parameters: <code className="font-mono">title</code>, <code className="font-mono">body</code> (or a request body),{" "}
							<code className="font-mono">url</code>, <code className="font-mono">priority</code>, <code className="font-mono">tags</code>.
						</CardDescription>
					</CardHeader>
					<CardContent>
						{!topics.data || !tokens.data ? (
							<p className="text-sm text-muted-foreground">Loading…</p>
						) : (
							<CurlBuilder baseUrl={base} topics={topics.data.map((t) => t.name)} tokens={usable} preferTokenId={mine} />
						)}
					</CardContent>
				</Card>
			)}
		</>
	);
}
