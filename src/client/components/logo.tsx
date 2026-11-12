import { cn } from "@/lib/utils";

/** Lemmeknow mark: a bell on a violet tile (same as favicon.svg). */
export function Logo({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 64 64" className={cn("size-7", className)} aria-hidden="true">
			<rect width="64" height="64" rx="14" fill="#7c3aed" />
			<path d="M32 13c-8 0-13.5 6-13.5 14v8.5L14 42.5h36l-4.5-7V27C45.5 19 40 13 32 13z" fill="none" stroke="#fff" strokeWidth="4.5" strokeLinejoin="round" />
			<path d="M26.5 48a5.5 5.5 0 0 0 11 0" fill="none" stroke="#fff" strokeWidth="4.5" strokeLinecap="round" />
		</svg>
	);
}
