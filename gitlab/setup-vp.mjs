/// <reference types="node" />
// @ts-check
import { createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const env = process.env;
const NODE_AUTH_TOKEN_REF = "${NODE_AUTH_TOKEN}";
const SFW_VERSION = "v1.12.0";
const SFW_RELEASE_BASE = `https://github.com/SocketDev/sfw-free/releases/download/${SFW_VERSION}`;

/**
 * @typedef {{ cwd?: string, args?: string[] }} RunInstallEntry
 * @typedef {string | string[] | number | boolean | null | object | undefined} RunInstallField
 * @typedef {{ [key: string]: string | undefined }} RuntimeEnv
 */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`setup-vp: ${message}`);
  process.exit(1);
}

/**
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * @param {string} name
 * @param {string | undefined} value
 */
function exportShellEnv(name, value) {
  if (!env.SETUP_VP_ENV_FILE || value === undefined) return;
  writeFileSync(env.SETUP_VP_ENV_FILE, `export ${name}=${shellQuote(value)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * @param {string | undefined | null} version
 * @returns {string}
 */
export function normalizeNodeVersion(version) {
  let normalized = String(version || "").replace(/^[vV]/, "");
  const lower = normalized.toLowerCase();
  if (lower === "node" || lower === "stable") normalized = "latest";
  return normalized;
}

/**
 * @param {string} filePath
 * @returns {string | undefined}
 */
export function parsePlainNodeVersionFile(filePath) {
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line) return normalizeNodeVersion(line);
  }
  return undefined;
}

/**
 * @param {string} filePath
 * @returns {string | undefined}
 */
export function parseToolVersionsNode(filePath) {
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const [tool, ...versions] = line.split(/\s+/);
    if (tool !== "nodejs" && tool !== "node") continue;

    for (const version of versions) {
      if (
        version &&
        version !== "system" &&
        !version.startsWith("ref:") &&
        !version.startsWith("path:")
      ) {
        return normalizeNodeVersion(version);
      }
    }
  }
  return undefined;
}

/**
 * @param {object | null} value
 * @returns {value is { devEngines?: { runtime?: { name?: string, version?: string } | { name?: string, version?: string }[] }, engines?: { node?: string } }}
 */
function isPackageJsonLike(value) {
  return !!value && typeof value === "object";
}

/**
 * @param {string} filePath
 * @returns {string | undefined}
 */
export function parsePackageJsonNode(filePath) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("Failed to parse package.json: invalid JSON");
  }

  if (!isPackageJsonLike(pkg)) return undefined;

  const runtime = pkg.devEngines?.runtime;
  const entries = Array.isArray(runtime) ? runtime : [runtime];
  for (const entry of entries) {
    if (entry?.name === "node" && typeof entry.version === "string") {
      return normalizeNodeVersion(entry.version);
    }
  }

  if (typeof pkg.engines?.node === "string") {
    return normalizeNodeVersion(pkg.engines.node);
  }

  return undefined;
}

/**
 * @param {string} inputPath
 * @param {string} projectDir
 * @returns {string}
 */
export function resolveNodeVersionFile(inputPath, projectDir) {
  const filePath = path.isAbsolute(inputPath) ? inputPath : path.join(projectDir, inputPath);
  let version;

  try {
    const filename = path.basename(filePath);
    if (filename === ".tool-versions") {
      version = parseToolVersionsNode(filePath);
    } else if (filename === "package.json") {
      version = parsePackageJsonNode(filePath);
    } else {
      version = parsePlainNodeVersionFile(filePath);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`node-version-file not found: ${filePath}`);
    }
    throw error;
  }

  if (!version) throw new Error(`No Node.js version found in ${inputPath}`);
  return version;
}

/**
 * @param {string} value
 * @returns {string}
 */
function parseScalar(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * @param {string} value
 * @returns {string[]}
 */
export function parseFlowArray(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`args must be an array, got: ${value}`);
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];

  const result = [];
  let current = "";
  let quote = "";

  for (const char of body) {
    if (quote) {
      if (char === quote) quote = "";
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      result.push(parseScalar(current));
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) result.push(parseScalar(current));
  return result;
}

/**
 * @param {string} line
 * @returns {[string, string] | undefined}
 */
function parseKeyValue(line) {
  const index = line.indexOf(":");
  if (index < 0) return undefined;
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

/**
 * @param {RunInstallEntry} target
 * @param {string} key
 * @param {string} value
 */
function assignValue(target, key, value) {
  if (key === "cwd") {
    target.cwd = parseScalar(value);
    return;
  }
  if (key === "args") {
    target.args = parseFlowArray(value);
    return;
  }
  throw new Error(`unsupported run-install key: ${key}`);
}

/**
 * @param {string[]} lines
 * @returns {RunInstallEntry}
 */
function parseObject(lines) {
  /** @type {RunInstallEntry} */
  const item = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const entry = parseKeyValue(line);
    if (!entry) throw new Error(`invalid run-install line: ${rawLine}`);
    assignValue(item, entry[0], entry[1]);
  }
  return item;
}

/**
 * @param {string} value
 * @returns {RunInstallEntry[]}
 */
export function parseYamlSubset(value) {
  const lines = value.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));
  if (lines.length === 0) return [];

  if (!lines[0].trimStart().startsWith("-")) {
    return [parseObject(lines)];
  }

  /** @type {RunInstallEntry[]} */
  const items = [];
  /** @type {RunInstallEntry | undefined} */
  let current = undefined;
  for (const rawLine of lines) {
    const trimmedStart = rawLine.trimStart();
    if (trimmedStart.startsWith("-")) {
      if (current) items.push(current);
      current = {};
      const rest = trimmedStart.slice(1).trim();
      if (rest) {
        const entry = parseKeyValue(rest);
        if (!entry) throw new Error(`invalid run-install line: ${rawLine}`);
        assignValue(current, entry[0], entry[1]);
      }
      continue;
    }

    if (!current) throw new Error(`invalid run-install line: ${rawLine}`);
    const entry = parseKeyValue(trimmedStart);
    if (!entry) throw new Error(`invalid run-install line: ${rawLine}`);
    assignValue(current, entry[0], entry[1]);
  }
  if (current) items.push(current);
  return items;
}

/**
 * @param {string | undefined | null} value
 * @returns {RunInstallEntry[]}
 */
function normalizeRunInstall(value) {
  const input = String(value || "").trim();
  if (!input || input === "false" || input === "null") return [];
  if (input === "true") return [{}];

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    return parseYamlSubset(input);
  }

  if (parsed === null || parsed === false) return [];
  if (parsed === true) return [{}];

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.map(normalizeRunInstallItem);
}

/**
 * @param {object | boolean | null} value
 * @returns {object}
 */
function asRunInstallRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("run-install entries must be objects with optional cwd and args");
  }
  return value;
}

/**
 * @param {object} record
 * @param {"cwd" | "args"} key
 * @returns {RunInstallField}
 */
function getRunInstallField(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key) ? Reflect.get(record, key) : undefined;
}

/**
 * @param {RunInstallField} value
 * @returns {value is string[]}
 */
function isStringArray(value) {
  return Array.isArray(value) && value.every((arg) => typeof arg === "string");
}

/**
 * @param {object | boolean | null} item
 * @returns {RunInstallEntry}
 */
export function normalizeRunInstallItem(item) {
  const candidate = asRunInstallRecord(item);
  /** @type {RunInstallEntry} */
  const normalized = {};
  const cwd = getRunInstallField(candidate, "cwd");
  if (cwd !== undefined) {
    if (typeof cwd !== "string") throw new Error("run-install.cwd must be a string");
    normalized.cwd = cwd;
  }
  const args = getRunInstallField(candidate, "args");
  if (args !== undefined) {
    if (!isStringArray(args)) {
      throw new Error("run-install.args must be an array of strings");
    }
    normalized.args = args;
  }
  return normalized;
}

/**
 * @param {string} value
 * @returns {RunInstallEntry[]}
 */
export function parseRunInstall(value) {
  return normalizeRunInstall(value).map(normalizeRunInstallItem);
}

/**
 * @param {string} registryUrlInput
 * @param {string} scopeInput
 * @param {RuntimeEnv} targetEnv
 * @returns {string | undefined}
 */
export function configureAuth(registryUrlInput, scopeInput, targetEnv = env) {
  if (!registryUrlInput) return;

  let url;
  try {
    url = new URL(registryUrlInput);
  } catch {
    throw new Error(`Invalid registry-url: "${registryUrlInput}". Must be a valid URL.`);
  }

  const registryUrl = url.href.endsWith("/") ? url.href : `${url.href}/`;
  let scopePrefix = "";
  if (scopeInput) {
    const scope = scopeInput.startsWith("@") ? scopeInput : `@${scopeInput}`;
    scopePrefix = `${scope.toLowerCase()}:`;
  }

  const authUrl = registryUrl.replace(/^\w+:/, "").toLowerCase();
  const npmrc = path.join(tmpdir(), `setup-vp-npmrc.${process.pid}`);
  const contents = `${authUrl}:_authToken=${NODE_AUTH_TOKEN_REF}\n${scopePrefix}registry=${registryUrl}\n`;
  writeFileSync(npmrc, contents, "utf8");

  targetEnv.NPM_CONFIG_USERCONFIG = npmrc;
  targetEnv.PNPM_CONFIG_USERCONFIG = npmrc;
  targetEnv.NODE_AUTH_TOKEN = targetEnv.NODE_AUTH_TOKEN || "XXXXX-XXXXX-XXXXX-XXXXX";
  if (targetEnv === env) {
    exportShellEnv("NPM_CONFIG_USERCONFIG", targetEnv.NPM_CONFIG_USERCONFIG);
    exportShellEnv("PNPM_CONFIG_USERCONFIG", targetEnv.PNPM_CONFIG_USERCONFIG);
    exportShellEnv("NODE_AUTH_TOKEN", targetEnv.NODE_AUTH_TOKEN);
  }
  return npmrc;
}

export function isMuslLinux() {
  if (process.platform !== "linux") return false;
  try {
    const report = /** @type {{ header?: { glibcVersionRuntime?: string } } | undefined} */ (
      process.report?.getReport()
    );
    if (report?.header && !report.header.glibcVersionRuntime) {
      return true;
    }
  } catch {
    // Fall through to filesystem fallback.
  }
  return existsSync("/etc/alpine-release");
}

/**
 * Mirrors src/install-sfw.ts asset naming for GitLab's supported Unix runners.
 *
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 * @param {boolean} isMusl
 * @returns {string | undefined}
 */
export function getSfwAssetName(platform, arch, isMusl) {
  if (platform === "darwin") {
    if (arch === "x64") return "sfw-free-macos-x86_64";
    if (arch === "arm64") return "sfw-free-macos-arm64";
  }

  if (platform === "linux") {
    if (arch === "x64") return isMusl ? "sfw-free-musl-linux-x86_64" : "sfw-free-linux-x86_64";
    if (arch === "arm64") return isMusl ? "sfw-free-musl-linux-arm64" : "sfw-free-linux-arm64";
  }

  const libcSuffix = platform === "linux" ? ` (${isMusl ? "musl" : "glibc"})` : "";
  throw new Error(`Unsupported platform/arch for sfw: ${platform}/${arch}${libcSuffix}`);
}

/**
 * @returns {string | undefined}
 */
export function sfwAssetName() {
  try {
    return getSfwAssetName(process.platform, process.arch, isMuslLinux());
  } catch {
    return undefined;
  }
}

/**
 * @returns {boolean}
 */
export function isSfwSupported() {
  return !!sfwAssetName();
}

/**
 * @returns {string}
 */
function sfwEnvironmentDescription() {
  return `process.platform=${process.platform}, process.arch=${process.arch}, musl=${isMuslLinux()}`;
}

/**
 * @param {string} command
 * @returns {string | undefined}
 */
function commandPath(command) {
  const result = spawnSync("sh", ["-c", `command -v "${command}"`], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim();
  return undefined;
}

/**
 * @param {string} url
 * @param {string} outputPath
 * @param {number} [redirects]
 * @returns {Promise<void>}
 */
function downloadFile(url, outputPath, redirects = 0) {
  if (redirects > 5) {
    return Promise.reject(new Error(`too many redirects while downloading ${url}`));
  }

  const client = url.startsWith("https:") ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const request = client(url, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        const nextUrl = new URL(location, url).toString();
        downloadFile(nextUrl, outputPath, redirects + 1).then(() => resolve(), reject);
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed with HTTP ${statusCode}: ${url}`));
        return;
      }

      const file = createWriteStream(outputPath);
      response.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    });
    request.on("error", reject);
  });
}

/**
 * @param {RunInstallEntry[]} runInstallEntries
 * @returns {Promise<"vp" | "sfw">}
 */
async function setupSfw(runInstallEntries) {
  if (env.SETUP_VP_SFW !== "true") return "vp";

  if (runInstallEntries.length === 0) {
    console.log(
      "setup-vp: sfw was requested but run-install is disabled; sfw will not be invoked.",
    );
    return "vp";
  }

  const existing = commandPath("sfw");
  if (existing) {
    console.log(`setup-vp: using existing sfw on PATH: ${existing}`);
    return "sfw";
  }

  const asset = sfwAssetName();
  if (!asset) {
    console.error(
      `setup-vp: sfw has no published binary for this runner's platform/architecture (${sfwEnvironmentDescription()}) and none was found on PATH; falling back to plain vp install.`,
    );
    return "vp";
  }

  const sfwDir = await mkdtemp(path.join(tmpdir(), "setup-vp-sfw-"));
  const sfwBin = path.join(sfwDir, "sfw");
  const sfwUrl = `${SFW_RELEASE_BASE}/${asset}`;

  for (let round = 1; round <= 2; round += 1) {
    try {
      console.log(`setup-vp: installing sfw ${SFW_VERSION} from ${sfwUrl}`);
      await downloadFile(sfwUrl, sfwBin);
      await chmod(sfwBin, 0o755);
      env.PATH = `${sfwDir}:${env.PATH || ""}`;
      exportShellEnv("PATH", env.PATH);
      return "sfw";
    } catch (error) {
      if (round === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw new Error("failed to install sfw after retrying");
}

/**
 * @param {RunInstallEntry[]} entries
 * @param {string} projectDir
 * @param {"vp" | "sfw"} installCommand
 */
function runInstall(entries, projectDir, installCommand) {
  for (const entry of entries) {
    const cwd = entry.cwd ? path.resolve(projectDir, entry.cwd) : projectDir;
    const installArgs = ["install", ...(entry.args || [])];
    const args = installCommand === "sfw" ? ["vp", ...installArgs] : installArgs;
    console.log(`setup-vp: running ${installCommand} ${args.join(" ")} in ${cwd}`);
    run(installCommand, args, { cwd });
  }
}

/**
 * @param {RuntimeEnv} runtimeEnv
 * @returns {string}
 */
export function resolveProjectDir(runtimeEnv = env) {
  const workingDirectory = runtimeEnv.SETUP_VP_WORKING_DIRECTORY || ".";
  const projectDir = path.isAbsolute(workingDirectory)
    ? workingDirectory
    : path.join(runtimeEnv.CI_PROJECT_DIR || process.cwd(), workingDirectory);

  try {
    if (!statSync(projectDir).isDirectory()) {
      throw new Error(
        `working-directory is not a directory: ${workingDirectory} (resolved to ${projectDir})`,
      );
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `working-directory not found: ${workingDirectory} (resolved to ${projectDir})`,
      );
    }
    throw error;
  }

  return projectDir;
}

/**
 * @returns {Promise<void>}
 */
export async function main() {
  const nodeVersion = env.SETUP_VP_NODE_VERSION || "lts";
  const nodeVersionFile = env.SETUP_VP_NODE_VERSION_FILE || "";
  const projectDir = resolveProjectDir(env);

  let effectiveNodeVersion = nodeVersion;
  if (nodeVersionFile) {
    effectiveNodeVersion = resolveNodeVersionFile(nodeVersionFile, projectDir);
    console.log(
      `setup-vp: resolved Node.js version ${effectiveNodeVersion} from ${nodeVersionFile}`,
    );
  }

  if (effectiveNodeVersion) {
    run("vp", ["env", "use", effectiveNodeVersion]);
  }

  configureAuth(env.SETUP_VP_REGISTRY_URL || "", env.SETUP_VP_SCOPE || "", env);

  const runInstallEntries = parseRunInstall(env.SETUP_VP_RUN_INSTALL || "true");

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
