import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  configureAuth,
  normalizeNodeVersion,
  parseFlowArray,
  parsePackageJsonNode,
  parsePlainNodeVersionFile,
  parseRunInstall,
  shellQuote,
  parseToolVersionsNode,
  resolveNodeVersionFile,
  resolveProjectDir,
} from "./setup-vp.mjs";

/** @type {string[]} */
const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "setup-vp-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GitLab setup runtime", () => {
  it("quotes shell environment values", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("has spaces")).toBe("'has spaces'");
    expect(shellQuote("it's ok")).toBe("'it'\\''s ok'");
  });

  it("normalizes node aliases and v-prefixed versions", () => {
    expect(normalizeNodeVersion("v22.11.0")).toBe("22.11.0");
    expect(normalizeNodeVersion("V20")).toBe("20");
    expect(normalizeNodeVersion("node")).toBe("latest");
    expect(normalizeNodeVersion("Node")).toBe("latest");
    expect(normalizeNodeVersion("stable")).toBe("latest");
    expect(normalizeNodeVersion("Stable")).toBe("latest");
  });

  it("parses plain node version files", () => {
    const dir = tempDir();
    const file = path.join(dir, ".node-version");
    writeFileSync(file, "\n# comment\nv24.1.0 # inline\n", "utf8");

    expect(parsePlainNodeVersionFile(file)).toBe("24.1.0");
  });

  it("parses .tool-versions node entries", () => {
    const dir = tempDir();
    const file = path.join(dir, ".tool-versions");
    writeFileSync(file, "ruby 3.4.0\nnodejs system ref:test 22.3.0\n", "utf8");

    expect(parseToolVersionsNode(file)).toBe("22.3.0");
  });

  it("prefers package.json devEngines.runtime over engines.node", () => {
    const dir = tempDir();
    const file = path.join(dir, "package.json");
    writeFileSync(
      file,
      JSON.stringify({
        devEngines: { runtime: [{ name: "node", version: "v24.0.0" }] },
        engines: { node: "22" },
      }),
      "utf8",
    );

    expect(parsePackageJsonNode(file)).toBe("24.0.0");
  });

  it("resolves node version files relative to the project directory", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".nvmrc"), "stable\n", "utf8");

    expect(resolveNodeVersionFile(".nvmrc", dir)).toBe("latest");
  });

  it("parses run-install booleans, JSON, and the supported YAML subset", () => {
    expect(parseRunInstall("false")).toEqual([]);
    expect(parseRunInstall("true")).toEqual([{}]);
    expect(parseRunInstall('{"cwd":"app","args":["--frozen-lockfile"]}')).toEqual([
      { cwd: "app", args: ["--frozen-lockfile"] },
    ]);
    expect(parseRunInstall("- cwd: ./app\n  args: ['--frozen-lockfile']\n- cwd: ./lib")).toEqual([
      { cwd: "./app", args: ["--frozen-lockfile"] },
      { cwd: "./lib" },
    ]);
  });

  it("rejects unsupported run-install keys", () => {
    expect(() => parseRunInstall("command: install")).toThrow(
      "unsupported run-install key: command",
    );
  });

  it("parses quoted flow array items", () => {
    expect(parseFlowArray("['--filter', \"@scope/app\"]")).toEqual(["--filter", "@scope/app"]);
  });

  it("writes registry auth config and updates the provided env object", () => {
    /** @type {{ [key: string]: string | undefined }} */
    const targetEnv = {};
    const npmrc = configureAuth("https://npm.pkg.github.com", "MyOrg", targetEnv);

    expect(npmrc).toBeTruthy();
    if (!npmrc) throw new Error("expected configureAuth to return an npmrc path");
    expect(targetEnv.NPM_CONFIG_USERCONFIG).toBe(npmrc);
    expect(targetEnv.PNPM_CONFIG_USERCONFIG).toBe(npmrc);
    expect(targetEnv.NODE_AUTH_TOKEN).toBe("XXXXX-XXXXX-XXXXX-XXXXX");
    expect(readFileSync(npmrc, "utf8")).toBe(
      "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n@myorg:registry=https://npm.pkg.github.com/\n",
    );
  });

  it("writes registry auth exports for the GitLab job shell", () => {
    const dir = tempDir();
    const envFile = path.join(dir, "env.sh");
    writeFileSync(envFile, "", "utf8");

    const previousEnvFile = process.env.SETUP_VP_ENV_FILE;
    const previousNodeAuthToken = process.env.NODE_AUTH_TOKEN;
    const previousNpmConfig = process.env.NPM_CONFIG_USERCONFIG;
    const previousPnpmConfig = process.env.PNPM_CONFIG_USERCONFIG;

    try {
      process.env.SETUP_VP_ENV_FILE = envFile;
      delete process.env.NODE_AUTH_TOKEN;
      configureAuth("https://npm.pkg.github.com", "MyOrg");

      const exports = readFileSync(envFile, "utf8");
      expect(exports).toContain("export NPM_CONFIG_USERCONFIG=");
      expect(exports).toContain("export PNPM_CONFIG_USERCONFIG=");
      expect(exports).toContain("export NODE_AUTH_TOKEN='XXXXX-XXXXX-XXXXX-XXXXX'");
    } finally {
      if (previousEnvFile === undefined) delete process.env.SETUP_VP_ENV_FILE;
      else process.env.SETUP_VP_ENV_FILE = previousEnvFile;
      if (previousNodeAuthToken === undefined) delete process.env.NODE_AUTH_TOKEN;
      else process.env.NODE_AUTH_TOKEN = previousNodeAuthToken;
      if (previousNpmConfig === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
      else process.env.NPM_CONFIG_USERCONFIG = previousNpmConfig;
      if (previousPnpmConfig === undefined) delete process.env.PNPM_CONFIG_USERCONFIG;
      else process.env.PNPM_CONFIG_USERCONFIG = previousPnpmConfig;
    }
  });

  it("rejects invalid registry URLs", () => {
    expect(() => configureAuth("not-a-url", "", {})).toThrow("Invalid registry-url");
  });

  it("resolves and validates the configured project directory", () => {
    const root = tempDir();
    mkdirSync(path.join(root, "web"));

    expect(
      resolveProjectDir({
        CI_PROJECT_DIR: root,
        SETUP_VP_WORKING_DIRECTORY: "web",
      }),
    ).toBe(path.join(root, "web"));
  });
});
