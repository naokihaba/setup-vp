import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { downloadFile, getSfwAssetName, setupSfw } from "./install-sfw.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "setup-vp-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GitLab sfw setup", () => {
  it("maps supported sfw release asset names", () => {
    expect(getSfwAssetName("linux", "x64", false)).toBe("sfw-free-linux-x86_64");
    expect(getSfwAssetName("linux", "x64", true)).toBe("sfw-free-musl-linux-x86_64");
    expect(getSfwAssetName("linux", "arm64", false)).toBe("sfw-free-linux-arm64");
    expect(getSfwAssetName("darwin", "arm64", false)).toBe("sfw-free-macos-arm64");
    expect(() => getSfwAssetName("win32", "x64", false)).toThrow(
      "Unsupported platform/arch for sfw",
    );
  });

  it("does not set up sfw when disabled or run-install is disabled", async () => {
    expect(await setupSfw([{}], { SETUP_VP_SFW: "false" })).toBe("vp");
    expect(await setupSfw([], { SETUP_VP_SFW: "true" })).toBe("vp");
  });

  it("uses an existing sfw command from PATH", async () => {
    const dir = tempDir();
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir);
    const sfwBin = path.join(binDir, "sfw");
    writeFileSync(sfwBin, "#!/usr/bin/env sh\nexit 0\n", "utf8");
    chmodSync(sfwBin, 0o755);

    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}:${previousPath || ""}`;
      expect(await setupSfw([{}], { SETUP_VP_SFW: "true", PATH: process.env.PATH })).toBe("sfw");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("times out stalled downloads", async () => {
    const dir = tempDir();
    const stalledClient: Parameters<typeof downloadFile>[4] = () => {
      const request = new EventEmitter() as EventEmitter & {
        destroy(error?: Error): void;
      };
      request.destroy = (error?: Error) => {
        if (error) request.emit("error", error);
      };
      return request as ReturnType<NonNullable<Parameters<typeof downloadFile>[4]>>;
    };

    await expect(
      downloadFile("http://example.test/sfw", path.join(dir, "sfw"), 0, 20, stalledClient),
    ).rejects.toThrow("download timed out after 20ms");
  });
});
