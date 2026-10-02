import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageCommandEnv } from "../../src/pod-exec.js";

const SECRET = "sk-ant-oat01-SECRET'with\"quotes $(id) `id` ü";

describe("stageCommandEnv", () => {
  it("returns null when there is nothing to apply", () => {
    expect(stageCommandEnv(["claude"], undefined)).toBeNull();
    expect(stageCommandEnv(["claude"], {})).toBeNull();
    expect(stageCommandEnv(["claude"], { PATH: "/server/bin" })).toBeNull();
  });

  it("keeps every value out of both commands' argv", () => {
    const staged = stageCommandEnv(["claude", "--print"], { CLAUDE_CODE_OAUTH_TOKEN: SECRET, X: "plain-value" })!;
    const argv = [...staged.stageCommand, ...staged.runCommand].join("\n");
    expect(argv).not.toContain("sk-ant-oat01");
    expect(argv).not.toContain("plain-value");
    expect(staged.stageStdin.toString("utf8")).toContain("plain-value");
    expect(staged.runCommand.slice(-2)).toEqual(["claude", "--print"]);
  });

  it("tells head the exact UTF-8 byte count of stdin", () => {
    const staged = stageCommandEnv(["c"], { V: "ü€" })!;
    expect(staged.stageCommand[2]).toContain(`head -c ${staged.stageStdin.length} `);
    expect(staged.stageStdin.length).toBeGreaterThan(staged.stageStdin.toString("utf8").length);
  });

  it("skips PATH, invalid identifiers and non-string values", () => {
    const stdin = stageCommandEnv(["c"], {
      PATH: "/server/bin",
      "BAD-KEY": "x",
      GOOD_KEY: "y",
      // @ts-expect-error intentional non-string to exercise the guard
      NUMERIC: 5,
    })!.stageStdin.toString("utf8");
    expect(stdin).toBe("export GOOD_KEY='y'\n");
  });
});

describe("stageCommandEnv in a real shell", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function stage(env: Record<string, string>, command: string[], dir = newDir()) {
    const staged = stageCommandEnv(command, env, dir)!;
    const s = spawnSync(staged.stageCommand[0]!, staged.stageCommand.slice(1), { input: staged.stageStdin });
    expect(s.status).toBe(0);
    return { staged, file: staged.file };
  }

  function newDir() {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pc-env-")), "stage");
    dirs.push(path.dirname(dir));
    return dir;
  }

  it("delivers the exact values, writes the file 0600, and deletes it", () => {
    const { staged, file } = stage({ TOKEN: SECRET, OTHER: "two" }, ["/bin/sh", "-c", 'printf "%s|%s" "$TOKEN" "$OTHER"']);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const r = spawnSync(staged.runCommand[0]!, staged.runCommand.slice(1), { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${SECRET}|two`);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("passes the command's exit status and stdin through", () => {
    const { staged } = stage({ V: "x" }, ["/bin/sh", "-c", 'read line; printf "%s" "$line"; exit 3']);
    const r = spawnSync(staged.runCommand[0]!, staged.runCommand.slice(1), { input: "from-stdin\n", encoding: "utf8" });
    expect(r.stdout).toBe("from-stdin");
    expect(r.status).toBe(3);
  });

  it("fails, and still deletes the file, when it cannot be loaded", () => {
    const { staged, file } = stage({ V: "x" }, ["/bin/true"]);
    fs.writeFileSync(file, "this is not valid sh (\n", { mode: 0o600 });
    const r = spawnSync(staged.runCommand[0]!, staged.runCommand.slice(1));
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });
});
