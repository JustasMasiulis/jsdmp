import "./index.css";
import "dockview-core/dist/styles/dockview.css";
import { WASM_PROMISE } from "./lib/wasm";
import { initWasmDumpDebugger } from "./WasmDumpDebugger";

void WASM_PROMISE.then(() => {
	const root = document.getElementById("root");
	if (root) {
		initWasmDumpDebugger(root);
	}
});
