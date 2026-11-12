import * as S from "@radix-ui/react-switch";
import * as C from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof S.Root>) {
	return (
		<S.Root
			className={cn(
				"peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50",
				"data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
				className,
			)}
			{...props}
		>
			<S.Thumb className="pointer-events-none block size-4 rounded-full bg-white shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
		</S.Root>
	);
}

export function Checkbox({ className, ...props }: React.ComponentProps<typeof C.Root>) {
	return (
		<C.Root
			className={cn(
				"peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50",
				"data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
				className,
			)}
			{...props}
		>
			<C.Indicator className="flex items-center justify-center">
				<Check className="size-3.5" strokeWidth={3} />
			</C.Indicator>
		</C.Root>
	);
}

/** Switch with a label and optional description, as one clickable row. */
export function SwitchRow({
	label,
	description,
	checked,
	onCheckedChange,
	disabled,
}: {
	label: React.ReactNode;
	description?: React.ReactNode;
	checked: boolean;
	onCheckedChange: (v: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<label className="flex cursor-pointer items-start justify-between gap-4 py-1.5">
			<span className="grid gap-0.5">
				<span className="text-sm font-medium">{label}</span>
				{description && <span className="text-xs text-muted-foreground">{description}</span>}
			</span>
			<Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
		</label>
	);
}

export function CheckRow({
	label,
	description,
	checked,
	onCheckedChange,
}: {
	label: React.ReactNode;
	description?: React.ReactNode;
	checked: boolean;
	onCheckedChange: (v: boolean) => void;
}) {
	return (
		<label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/50">
			<Checkbox checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} className="mt-0.5" />
			<span className="grid gap-0.5">
				<span className="text-sm">{label}</span>
				{description && <span className="text-xs text-muted-foreground">{description}</span>}
			</span>
		</label>
	);
}
