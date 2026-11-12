import { cn } from "@/lib/utils";

export function PageHeader({
	title,
	description,
	actions,
	className,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("mb-5 flex flex-wrap items-end justify-between gap-3", className)}>
			<div className="min-w-0">
				<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
				{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
			</div>
			{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}

/** Dense table primitives (Beszel style). */
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
	return (
		<div className="w-full overflow-x-auto">
			<table className={cn("w-full caption-bottom text-sm", className)} {...props} />
		</div>
	);
}
export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
	return <th className={cn("h-9 whitespace-nowrap px-3 text-left align-middle text-xs font-medium text-muted-foreground", className)} {...props} />;
}
export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
	return <td className={cn("px-3 py-2 align-middle", className)} {...props} />;
}
export function Tr({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
	return <tr className={cn("border-b transition-colors last:border-0 hover:bg-muted/40", className)} {...props} />;
}
