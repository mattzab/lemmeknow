import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
	return (
		<div className="space-y-2 p-4">
			{Array.from({ length: rows }, (_, i) => (
				<div key={i} className="flex gap-4">
					{Array.from({ length: cols }, (_, j) => (
						<Skeleton key={j} className={cn("h-5", j === 0 ? "w-40" : "flex-1")} />
					))}
				</div>
			))}
		</div>
	);
}

export function CardsSkeleton({ count = 6, className }: { count?: number; className?: string }) {
	return (
		<div className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-3", className)}>
			{Array.from({ length: count }, (_, i) => (
				<Skeleton key={i} className="h-40 rounded-lg" />
			))}
		</div>
	);
}
