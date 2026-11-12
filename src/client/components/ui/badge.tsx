import { cn } from "@/lib/utils";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
	return (
		<span
			className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium leading-none text-muted-foreground", className)}
			{...props}
		/>
	);
}

export function TagChip({ tag, active, onClick, className }: { tag: string; active?: boolean; onClick?: () => void; className?: string }) {
	const Comp = onClick ? "button" : "span";
	return (
		<Comp
			type={onClick ? "button" : undefined}
			onClick={onClick}
			className={cn(
				"inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
				active ? "border-primary/50 bg-primary/15 text-primary" : "text-muted-foreground",
				onClick && "hover:border-primary/40 hover:text-foreground",
				className,
			)}
		>
			{tag}
		</Comp>
	);
}
