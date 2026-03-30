import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Node may call exec(cmd, cb) or exec(cmd, opts, cb); promisify uses the latter. */
function asExecCallback(
  arg2: unknown,
  arg3?: unknown,
): (err: Error | null, stdout?: string, stderr?: string) => void {
  if (typeof arg2 === "function") {
    return arg2 as (err: Error | null, stdout?: string, stderr?: string) => void;
  }
  return arg3 as (err: Error | null, stdout?: string, stderr?: string) => void;
}

const execImpl = vi.hoisted(() =>
  vi.fn((cmd: string, arg2: unknown, arg3?: unknown) => {
    asExecCallback(arg2, arg3)(null, "out\n", "");
  }),
);

const execExport = vi.hoisted(() => {
  const customPromisify = Symbol.for("nodejs.util.promisify.custom");
  return Object.assign(execImpl, {
    [customPromisify](command: string, options?: Record<string, unknown>) {
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execImpl(
          command,
          options ?? {},
          (err: Error | null, stdout?: string, stderr?: string) => {
            if (err) {
              reject(err);
            } else {
              resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
            }
          },
        );
      });
    },
  });
});

vi.mock("child_process", () => ({
  exec: execExport,
}));

describe("CommandService", () => {
  let tmpDir: string;
  let previousWorkspace: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ansible-cmd-svc-"));
    previousWorkspace = process.env.ANSIBLE_ENV_WORKSPACE;
    process.env.ANSIBLE_ENV_WORKSPACE = tmpDir;
    execImpl.mockReset();
    execImpl.mockImplementation((cmd: string, arg2: unknown, arg3?: unknown) => {
      asExecCallback(arg2, arg3)(null, "out\n", "");
    });
  });

  afterEach(() => {
    if (previousWorkspace === undefined) {
      delete process.env.ANSIBLE_ENV_WORKSPACE;
    } else {
      process.env.ANSIBLE_ENV_WORKSPACE = previousWorkspace;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("getInstance returns the same singleton", async () => {
    const { CommandService } = await import("../../src/services/CommandService");
    const a = CommandService.getInstance();
    const b = CommandService.getInstance();
    expect(a).toBe(b);
  });

  it("runCommand executes via child_process.exec and returns stdout", async () => {
    execImpl.mockImplementation((_cmd: string, arg2: unknown, arg3?: unknown) => {
      asExecCallback(arg2, arg3)(null, "  hello  \n", "");
    });
    const { CommandService } = await import("../../src/services/CommandService");
    const svc = CommandService.getInstance();
    const result = await svc.runCommand('echo "test"', { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(execImpl).toHaveBeenCalled();
  });

  it("runCommand maps exec failures to exitCode and stderr", async () => {
    const err = Object.assign(new Error("command failed"), {
      code: 127,
      stdout: "partial\n",
      stderr: "not found\n",
    });
    execImpl.mockImplementation((_cmd: string, arg2: unknown, arg3?: unknown) => {
      asExecCallback(arg2, arg3)(err, "partial\n", "not found\n");
    });
    const { CommandService } = await import("../../src/services/CommandService");
    const svc = CommandService.getInstance();
    const result = await svc.runCommand("false", { cwd: tmpDir });
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("partial");
    expect(result.stderr).toContain("not found");
  });
});
