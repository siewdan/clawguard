import { createPluginRuntime } from "./src/plugin.js";

export default function register(api) {
  const runtime = createPluginRuntime(api);
  runtime.register();
}
