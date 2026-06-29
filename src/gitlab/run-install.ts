import path from "node:path";
import { run } from "./shell.js";
import type { InstallCommand, RunInstallEntry, RunInstallInput } from "./types.js";

function parseScalar(value: string): string {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseFlowArray(value: string): string[] {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`args must be an array, got: ${value}`);
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];

  const result: string[] = [];
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

function parseKeyValue(line: string): [string, string] | undefined {
  const index = line.indexOf(":");
  if (index < 0) return undefined;
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

function assignValue(target: RunInstallEntry, key: string, value: string): void {
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

// Keep GitLab runtime validation local instead of using Zod. The bootstrap
// downloads and runs one generated .mjs file from /tmp, so shared chunks such
// as dist/schemas-*.mjs would break relative imports at runtime.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRunInstallEntry(value: unknown): RunInstallEntry {
  if (!isRecord(value)) {
    throw new Error("run-install entries must be objects");
  }

  for (const key of Object.keys(value)) {
    if (key !== "cwd" && key !== "args") {
      throw new Error(`unsupported run-install key: ${key}`);
    }
  }

  const entry: RunInstallEntry = {};
  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string") {
      throw new Error("run-install.cwd must be a string");
    }
    entry.cwd = value.cwd;
  }

  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
      throw new Error("run-install.args must be an array of strings");
    }
    entry.args = value.args;
  }

  return entry;
}

function validateRunInstallInput(value: unknown): RunInstallInput {
  if (value === null || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(validateRunInstallEntry);
  return validateRunInstallEntry(value);
}

function parseObject(lines: string[]): RunInstallEntry {
  const item: RunInstallEntry = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const entry = parseKeyValue(line);
    if (!entry) throw new Error(`invalid run-install line: ${rawLine}`);
    assignValue(item, entry[0], entry[1]);
  }
  return item;
}

export function parseYamlSubset(value: string): RunInstallEntry[] {
  const lines = value.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));
  if (lines.length === 0) return [];

  if (!lines[0].trimStart().startsWith("-")) {
    return [parseObject(lines)];
  }

  const items: RunInstallEntry[] = [];
  let current: RunInstallEntry | undefined = undefined;
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

export function parseRunInstall(value: string): RunInstallEntry[] {
  const input = String(value || "").trim();
  if (!input) return [];

  const parsed = parseRunInstallInput(input);
  return normalizeRunInstallInput(parsed);
}

function parseRunInstallInput(input: string): RunInstallInput {
  try {
    return validateRunInstallInput(JSON.parse(input));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw formatRunInstallError(error);
  }

  try {
    return validateRunInstallInput(parseYamlSubset(input));
  } catch (error) {
    throw formatRunInstallError(error);
  }
}

function normalizeRunInstallInput(input: RunInstallInput): RunInstallEntry[] {
  if (!input) return [];
  if (input === true) return [{}];
  return Array.isArray(input) ? input : [input];
}

function formatRunInstallError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export function runInstall(
  entries: RunInstallEntry[],
  projectDir: string,
  installCommand: InstallCommand,
): void {
  for (const entry of entries) {
    const cwd = entry.cwd ? path.resolve(projectDir, entry.cwd) : projectDir;
    const installArgs = ["install", ...(entry.args || [])];
    const args = installCommand === "sfw" ? ["vp", ...installArgs] : installArgs;
    console.log(`setup-vp: running ${installCommand} ${args.join(" ")} in ${cwd}`);
    run(installCommand, args, { cwd });
  }
}
