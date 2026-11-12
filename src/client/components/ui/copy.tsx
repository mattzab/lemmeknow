import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn, copyText } from "@/lib/utils";

export function CopyButton({ value, className, label }: { value: string; className?: string; label?: string }) {
	const [done, setDone] = useState(false);
	return (
		<button
			type="button"
			title="Copy to clipboard"
			onClick={async () => {
				if (await copyText(value)) {
					setDone(true);
					setTimeout(() => setDone(false), 1500);
				}
			}}
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-md border bg-background/80 px-1.5 py-1 text-xs text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground",
				className,
			)}
		>
			{done ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
			{label && <span>{done ? "Copied" : label}</span>}
		</button>
	);
}

/** Monospace block with a copy button in the corner. */
export function CodeBlock({ code, className, preClassName }: { code: string; className?: string; preClassName?: string }) {
	return (
		<div className={cn("group relative", className)}>
			<pre className={cn("overflow-auto rounded-md border bg-muted/50 p-3 pr-12 font-mono text-xs leading-relaxed", preClassName)}>{code}</pre>
			<CopyButton value={code} className="absolute right-2 top-2" />
		</div>
	);
}

/** Single-line monospace value with copy button. */
export function CopyField({ value, className, secret }: { value: string; className?: string; secret?: boolean }) {
	const [shown, setShown] = useState(!secret);
	return (
		<div className={cn("flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 py-1 pl-3 pr-1", className)}>
			<code
				className={cn("min-w-0 flex-1 truncate font-mono text-xs", secret && !shown && "cursor-pointer")}
				onClick={() => secret && setShown(true)}
				title={shown ? value : "Click to reveal"}
			>
				{shown ? value : "•".repeat(Math.min(32, value.length))}
			</code>
			<CopyButton value={value} />
		</div>
	);
}
