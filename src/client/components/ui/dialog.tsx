import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
	className,
	children,
	wide,
	...props
}: React.ComponentProps<typeof D.Content> & { wide?: boolean | "xl" }) {
	return (
		<D.Portal>
			<D.Overlay className="animate-overlay-in fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" />
			<D.Content
				aria-describedby={undefined}
				className={cn(
					"animate-content-in fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border bg-popover text-popover-foreground shadow-2xl",
					wide === "xl" ? "max-w-4xl" : wide ? "max-w-2xl" : "max-w-lg",
					className,
				)}
				{...props}
			>
				{children}
				<D.Close className="absolute right-3 top-3 rounded-sm p-1 text-muted-foreground opacity-70 transition hover:bg-accent hover:opacity-100">
					<X className="size-4" />
					<span className="sr-only">Close</span>
				</D.Close>
			</D.Content>
		</D.Portal>
	);
}

export function DialogHeader({ title, description }: { title: React.ReactNode; description?: React.ReactNode }) {
	return (
		<div className="space-y-1.5 border-b px-5 py-4 pr-10">
			<D.Title className="text-base font-semibold leading-none">{title}</D.Title>
			{description && <D.Description className="text-sm text-muted-foreground">{description}</D.Description>}
		</div>
	);
}

export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3", className)} {...props} />;
}
