import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Button } from "./button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "./dialog";

interface ConfirmOptions {
	title: string;
	description?: React.ReactNode;
	confirmLabel?: string;
	destructive?: boolean;
}
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
	const [opts, setOpts] = useState<ConfirmOptions | null>(null);
	const resolver = useRef<(v: boolean) => void>(undefined);
	const confirm = useCallback<ConfirmFn>((o) => {
		setOpts(o);
		return new Promise<boolean>((resolve) => {
			resolver.current = resolve;
		});
	}, []);
	const close = (v: boolean) => {
		resolver.current?.(v);
		resolver.current = undefined;
		setOpts(null);
	};
	return (
		<Ctx.Provider value={confirm}>
			{children}
			<Dialog open={opts != null} onOpenChange={(o) => !o && close(false)}>
				{opts && (
					<DialogContent className="max-w-md">
						<DialogHeader title={opts.title} />
						{opts.description && <DialogBody className="text-sm text-muted-foreground">{opts.description}</DialogBody>}
						<DialogFooter>
							<Button variant="outline" onClick={() => close(false)}>
								Cancel
							</Button>
							<Button variant={opts.destructive ? "destructive" : "default"} onClick={() => close(true)} autoFocus>
								{opts.confirmLabel ?? "Confirm"}
							</Button>
						</DialogFooter>
					</DialogContent>
				)}
			</Dialog>
		</Ctx.Provider>
	);
}

export function useConfirm(): ConfirmFn {
	const ctx = useContext(Ctx);
	if (!ctx) throw new Error("useConfirm outside ConfirmProvider");
	return ctx;
}
