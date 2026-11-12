import { Slot, Slottable } from "@radix-ui/react-slot";
import { Loader2 } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

const VARIANTS = {
	default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
	secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
	outline: "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
	ghost: "hover:bg-accent hover:text-accent-foreground",
	destructive: "bg-destructive text-white hover:bg-destructive/90 shadow-sm",
	link: "text-primary underline-offset-4 hover:underline px-0 h-auto",
} as const;
const SIZES = {
	default: "h-9 px-4 text-sm",
	sm: "h-8 px-3 text-xs",
	lg: "h-10 px-6 text-sm",
	icon: "h-9 w-9",
	"icon-sm": "h-8 w-8",
} as const;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: keyof typeof VARIANTS;
	size?: keyof typeof SIZES;
	loading?: boolean;
	/** Render the child element (e.g. a Link) with button styles. */
	asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant = "default", size = "default", loading, disabled, children, type = "button", asChild, ...props }, ref) => {
		const Comp = asChild ? Slot : "button";
		return (
		<Comp
			ref={ref}
			type={asChild ? undefined : type}
			disabled={disabled || loading}
			className={cn(
				"inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50",
				"[&_svg]:size-4 [&_svg]:shrink-0",
				VARIANTS[variant],
				SIZES[size],
				className,
			)}
			{...props}
		>
			{loading && <Loader2 className="animate-spin" />}
			<Slottable>{children}</Slottable>
		</Comp>
		);
	},
);
Button.displayName = "Button";
