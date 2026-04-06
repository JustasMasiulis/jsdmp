import "dockview-core/dist/styles/dockview.css";
import "./index.css";
import { loadWasm } from "./lib/wasm";
import { initWasmDumpDebugger } from "./WasmDumpDebugger";

loadWasm().then(() => {
	const root = document.getElementById("root");
	if (!root) {
		throw new Error("root element not found");
	}
	initWasmDumpDebugger(root);
});
