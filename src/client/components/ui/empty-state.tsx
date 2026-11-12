import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
	icon: Icon,
	title,
	children,
	action,
	className,
}: {
	icon: LucideIcon;
	title: string;
	children?: React.ReactNode;
	action?: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>
			<div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
				<Icon className="size-6" />
			</div>
			<div className="space-y-1">
				<h3 className="font-semibold">{title}</h3>
				{children && <p className="mx-auto max-w-md text-sm text-muted-foreground">{children}</p>}
			</div>
			{action}
		</div>
	);
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
	return (
		<div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
			<p className="font-medium text-destructive">Could not load data</p>
			<p className="mt-1 text-muted-foreground">{error.message}</p>
			{onRetry && (
				<button type="button" onClick={onRetry} className="mt-2 text-xs font-medium text-primary hover:underline">
					Try again
				</button>
			)}
		</div>
	);
}
