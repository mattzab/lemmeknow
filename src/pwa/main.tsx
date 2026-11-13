import "../client/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, getTheme } from "../client/lib/theme";
import App from "./App";
import { registerServiceWorker } from "./push";

applyTheme(getTheme());
void registerServiceWorker()?.catch((e) => console.warn("service worker registration failed", e));

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
