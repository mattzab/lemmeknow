import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/api";

type Kind = "success" | "error" | "info";
interface ToastItem {
	id: number;
	kind: Kind;
	title: string;
	description?: string;
}
interface ToastApi {
	success: (title: string, description?: string) => void;
	error: (title: string, description?: string) => void;
	info: (title: string, description?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
	const [items, setItems] = useState<ToastItem[]>([]);
	const next = useRef(1);
	const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((t) => t.id !== id)), []);
	const push = useCallback(
		(kind: Kind, title: string, description?: string) => {
			const id = next.current++;
			setItems((xs) => [...xs.slice(-4), { id, kind, title, description }]);
			setTimeout(() => dismiss(id), kind === "error" ? 7000 : 3500);
		},
		[dismiss],
	);
	const api = useMemo<ToastApi>(
		() => ({
			success: (t, d) => push("success", t, d),
			error: (t, d) => push("error", t, d),
			info: (t, d) => push("info", t, d),
		}),
		[push],
	);
	return (
		<Ctx.Provider value={api}>
			{children}
			<div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
				{items.map((t) => (
					<div
						key={t.id}
						role="status"
						className="animate-toast-in pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-xl"
					>
						{t.kind === "success" ? (
							<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
						) : t.kind === "error" ? (
							<XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
						) : (
							<Info className="mt-0.5 size-4 shrink-0 text-sky-500" />
						)}
						<div className="min-w-0 flex-1">
							<p className="text-sm font-medium">{t.title}</p>
							{t.description && <p className={cn("mt-0.5 break-words text-xs text-muted-foreground")}>{t.description}</p>}
						</div>
						<button type="button" onClick={() => dismiss(t.id)} className="text-muted-foreground hover:text-foreground">
							<X className="size-4" />
						</button>
					</div>
				))}
			</div>
		</Ctx.Provider>
	);
}

export function useToast(): ToastApi {
	const ctx = useContext(Ctx);
	if (!ctx) throw new Error("useToast outside ToastProvider");
	return ctx;
}

/**
 * Wrap an async action: tracks `busy`, toasts errors (and an optional success message).
 * Returns the action's result, or undefined when it failed.
 */
export function useAction() {
	const toast = useToast();
	const [busy, setBusy] = useState<string | null>(null);
	const run = useCallback(
		async <T,>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined> => {
			setBusy(key);
			try {
				const r = await fn();
				if (success) toast.success(typeof success === "function" ? success(r) : success);
				return r;
			} catch (e) {
				toast.error("Action failed", errorMessage(e));
				return undefined;
			} finally {
				setBusy(null);
			}
		},
		[toast],
	);
	return { run, busy };
}
