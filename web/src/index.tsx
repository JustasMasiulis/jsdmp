/* @refresh reload */
import "./index.css";
import "dockview-core/dist/styles/dockview.css";
import { render } from "solid-js/web";
import { WASM_PROMISE } from "./lib/wasm";
import WasmDumpDebugger from "./WasmDumpDebugger";

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
	throw new Error(
		"Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
	);
}

// load the was module before rendering the app
render(() => <WasmDumpDebugger />, root as HTMLElement);
