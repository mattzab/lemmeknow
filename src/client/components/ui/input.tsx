import { forwardRef } from "react";
import { cn } from "@/lib/utils";

const base =
	"w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs transition-colors placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-ring disabled:opacity-50 aria-invalid:border-destructive";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
	<input ref={ref} className={cn(base, "h-9", className)} {...props} />
));
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
	({ className, ...props }, ref) => <textarea ref={ref} className={cn(base, "min-h-20 py-2", className)} {...props} />,
);
Textarea.displayName = "Textarea";

const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`;

/** Styled native select (keyboard + mobile friendly). */
export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
	({ className, children, style, ...props }, ref) => (
		<select
			ref={ref}
			className={cn(base, "h-9 appearance-none bg-[length:16px] bg-[right_0.5rem_center] bg-no-repeat pr-8 [&>option]:bg-popover", className)}
			style={{ backgroundImage: CHEVRON, ...style }}
			{...props}
		>
			{children}
		</select>
	),
);
Select.displayName = "Select";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
	return <label className={cn("text-sm font-medium leading-none", className)} {...props} />;
}

/** Label + control + optional hint/error, stacked. */
export function Field({
	label,
	hint,
	error,
	htmlFor,
	className,
	children,
}: {
	label: React.ReactNode;
	hint?: React.ReactNode;
	error?: string;
	htmlFor?: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("grid content-start gap-1.5", className)}>
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
			{error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
		</div>
	);
}
