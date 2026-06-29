import { pathToFileURL } from "node:url";
import { configureAuth } from "./auth.js";
import { setupSfw } from "./install-sfw.js";
import { parseRunInstall, runInstall } from "./run-install.js";
import { run } from "./shell.js";
import { resolveProjectDir } from "./utils.js";

function fail(message: string): never {
  console.error(`setup-vp: ${message}`);
  process.exit(1);
}

export async function main(): Promise<void> {
  const projectDir = resolveProjectDir(process.env);

  configureAuth(process.env.SETUP_VP_REGISTRY_URL || "", process.env.SETUP_VP_SCOPE || "");

  const runInstallEntries = parseRunInstall(process.env.SETUP_VP_RUN_INSTALL || "true");

  const installCommand = await setupSfw(runInstallEntries);
  runInstall(runInstallEntries, projectDir, installCommand);

  run("vp", ["--version"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
