import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "lemmeknow-theme";

export function getTheme(): Theme {
	const saved = localStorage.getItem(KEY);
	if (saved === "dark" || saved === "light") return saved;
	return "dark";
}

export function applyTheme(theme: Theme) {
	document.documentElement.classList.toggle("dark", theme === "dark");
}

export function useTheme() {
	const [theme, setThemeState] = useState<Theme>(getTheme);
	useEffect(() => applyTheme(theme), [theme]);
	const setTheme = useCallback((t: Theme) => {
		localStorage.setItem(KEY, t);
		setThemeState(t);
	}, []);
	const toggle = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);
	return { theme, setTheme, toggle };
}
