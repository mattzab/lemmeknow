import type { ServerInfo } from "@shared/types";
import { BookOpen, Hash, KeyRound, LogOut, type LucideIcon, MessagesSquare, Moon, Search, Smartphone, Sun, Users } from "lucide-react";
import { createContext, useContext } from "react";
import { Link, Redirect, Route, Router, Switch, useLocation } from "wouter";
import { Logo } from "@/components/logo";
import { ConfirmProvider } from "@/components/ui/confirm";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { ToastProvider } from "@/components/ui/toast";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { useApi, useDocumentTitle } from "@/lib/hooks";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { MessagesPage } from "./pages/MessagesPage";
import { ConnectPage } from "./pages/ConnectPage";
import { TokensPage } from "./pages/TokensPage";
import { TopicsPage } from "./pages/TopicsPage";
import { UsersPage } from "./pages/UsersPage";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
	{ href: "/topics", label: "Topics", icon: Hash },
	{ href: "/messages", label: "Messages", icon: MessagesSquare },
	{ href: "/tokens", label: "Tokens", icon: KeyRound },
	{ href: "/users", label: "Users", icon: Users },
	{ href: "/connect", label: "Connect", icon: BookOpen },
];

const ServerCtx = createContext<ServerInfo | null>(null);
export const useServer = () => useContext(ServerCtx);

function Header({ me }: { me?: ServerInfo }) {
	const [location] = useLocation();
	const { theme, toggle } = useTheme();
	return (
		<header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
			<div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4 sm:px-6">
				<Link href="/topics" className="flex items-center gap-2 font-semibold tracking-tight">
					<Logo />
					<span className="hidden sm:inline">Lemmeknow</span>
				</Link>
				<nav className="hidden items-center gap-0.5 md:flex">
					{NAV.map((n) => {
						const active = location === n.href || location.startsWith(`${n.href}/`);
						return (
							<Link
								key={n.href}
								href={n.href}
								className={cn(
									"flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
									active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								<n.icon className="size-4" />
								{n.label}
							</Link>
						);
					})}
				</nav>
				<div className="ml-auto flex items-center gap-1.5">
					<Tooltip content="Open the Lemmeknow web app (install it on your phone from here)" side="bottom">
						<a href="/" className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
							<Smartphone className="size-4" />
							<span className="hidden sm:inline">Open app</span>
						</a>
					</Tooltip>
					<Tooltip content={theme === "dark" ? "Light mode" : "Dark mode"} side="bottom">
						<button
							type="button"
							onClick={toggle}
							className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
						</button>
					</Tooltip>
					{me && (
						<span className="hidden max-w-48 truncate rounded-md border px-2 py-1 text-xs text-muted-foreground lg:inline" title="Cloudflare Access identity">
							{me.email}
						</span>
					)}
					<Tooltip content="Log out of Cloudflare Access" side="bottom">
						<a href="/cdn-cgi/access/logout" className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
							<LogOut className="size-4" />
							<span className="hidden sm:inline">Log out</span>
						</a>
					</Tooltip>
				</div>
			</div>
			<nav className="flex gap-1 overflow-x-auto border-t px-3 py-1.5 md:hidden">
				{NAV.map((n) => {
					const active = location === n.href || location.startsWith(`${n.href}/`);
					return (
						<Link
							key={n.href}
							href={n.href}
							className={cn("flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium", active ? "bg-accent text-foreground" : "text-muted-foreground")}
						>
							<n.icon className="size-3.5" />
							{n.label}
						</Link>
					);
				})}
			</nav>
		</header>
	);
}

function NotFound() {
	useDocumentTitle("Not found · Lemmeknow");
	return (
		<EmptyState icon={Search} title="Page not found" action={<Link href="/topics" className="text-sm text-primary hover:underline">Go to topics</Link>}>
			The page you are looking for does not exist.
		</EmptyState>
	);
}

export default function App() {
	const me = useApi<ServerInfo>("/api/admin/me");
	return (
		<Router base="/admin">
			<ServerCtx.Provider value={me.data ?? null}>
				<TooltipProvider>
					<ToastProvider>
						<ConfirmProvider>
							<div className="min-h-dvh">
								<Header me={me.data} />
								<main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
									{me.error ? (
										<ErrorState error={me.error} onRetry={() => void me.reload()} />
									) : (
										<Switch>
											<Route path="/">
												<Redirect to="/topics" replace />
											</Route>
											<Route path="/topics" component={TopicsPage} />
											<Route path="/messages" component={MessagesPage} />
											<Route path="/tokens" component={TokensPage} />
											<Route path="/users" component={UsersPage} />
											<Route path="/connect" component={ConnectPage} />
											<Route component={NotFound} />
										</Switch>
									)}
								</main>
							</div>
						</ConfirmProvider>
					</ToastProvider>
				</TooltipProvider>
			</ServerCtx.Provider>
		</Router>
	);
}
