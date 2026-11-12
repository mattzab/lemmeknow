import * as T from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

export const TooltipProvider = T.Provider;

export function Tooltip({
	content,
	children,
	side = "top",
	className,
}: {
	content: React.ReactNode;
	children: React.ReactNode;
	side?: "top" | "bottom" | "left" | "right";
	className?: string;
}) {
	if (content == null || content === "") return <>{children}</>;
	return (
		<T.Root delayDuration={150}>
			<T.Trigger asChild>{children}</T.Trigger>
			<T.Portal>
				<T.Content
					side={side}
					sideOffset={6}
					className={cn("z-50 max-w-xs rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg", className)}
				>
					{content}
				</T.Content>
			</T.Portal>
		</T.Root>
	);
}
