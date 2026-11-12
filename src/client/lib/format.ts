export function ago(sec: number | null | undefined, now = Date.now()): string {
	if (!sec) return "never";
	const d = Math.round(now / 1000 - sec);
	if (d < 0) return `in ${span(-d)}`;
	if (d < 5) return "just now";
	return `${span(d)} ago`;
}

export function span(s: number): string {
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86400)}d`;
}

export function dateTime(sec: number): string {
	return new Date(sec * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const PRIORITY_LABEL: Record<number, string> = { 1: "min", 2: "low", 3: "default", 4: "high", 5: "urgent" };
