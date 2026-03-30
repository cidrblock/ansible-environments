import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runToolMock = vi.hoisted(() => vi.fn());
const getBinDirMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/CommandService", () => ({
  getCommandService: vi.fn(() => ({
    runTool: runToolMock,
    getBinDir: getBinDirMock,
  })),
}));

import { CollectionsService } from "../../src/services/CollectionsService";

function resetCollectionsSingleton(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (CollectionsService as any)._instance = undefined;
}

describe("CollectionsService", () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  const adeInspectStdout = JSON.stringify({
    "ansible.builtin": {
      path: "/collections/ansible/builtin",
      collection_info: {
        version: "1.0.0",
        authors: ["Ansible"],
        description: "Built-in collection",
      },
    },
  });

  const ansibleDocMetadata = JSON.stringify({
    all: {
      module: {
        "ansible.builtin.copy": {
          doc: {
            collection: "ansible.builtin",
            plugin_name: "ansible.builtin.copy",
            short_description: "Copy files to remote locations",
          },
        },
      },
    },
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ansible-coll-svc-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    getBinDirMock.mockResolvedValue(null);
    runToolMock.mockImplementation(async (toolName: string) => {
      if (toolName === "ade") {
        return { exitCode: 0, stdout: adeInspectStdout, stderr: "" };
      }
      if (toolName === "ansible-doc") {
        return { exitCode: 0, stdout: ansibleDocMetadata, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown tool" };
    });
    resetCollectionsSingleton();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetCollectionsSingleton();
    runToolMock.mockReset();
    getBinDirMock.mockReset();
  });

  it("getInstance returns the same singleton", () => {
    const a = CollectionsService.getInstance();
    const b = CollectionsService.getInstance();
    expect(a).toBe(b);
  });

  it("forceRefresh loads collection and plugin metadata from mocked ansible-doc output", async () => {
    const svc = CollectionsService.getInstance();
    await svc.forceRefresh();

    expect(svc.isLoaded()).toBe(true);
    const coll = svc.getCollection("ansible.builtin");
    expect(coll).toBeDefined();
    expect(coll!.info).toMatchObject({
      name: "ansible.builtin",
      version: "1.0.0",
      authors: ["Ansible"],
      description: "Built-in collection",
      path: "/collections/ansible/builtin",
    });

    const plugins = svc.getPlugins("ansible.builtin", "module");
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      name: "copy",
      fullName: "ansible.builtin.copy",
      shortDescription: "Copy files to remote locations",
    });
  });

  it("searchPlugins matches name, fullName, and shortDescription", async () => {
    const svc = CollectionsService.getInstance();
    await svc.forceRefresh();

    const byName = svc.searchPlugins("copy");
    expect(byName.some((r) => r.plugin.name === "copy")).toBe(true);

    const byFqcn = svc.searchPlugins("ansible.builtin.copy");
    expect(byFqcn.length).toBeGreaterThan(0);

    const byDesc = svc.searchPlugins("remote");
    expect(byDesc.length).toBeGreaterThan(0);
  });

  it("listCollectionNames and listPluginTypes expose loaded structure", async () => {
    const svc = CollectionsService.getInstance();
    await svc.forceRefresh();

    expect(svc.listCollectionNames()).toContain("ansible.builtin");
    expect(svc.listPluginTypes("ansible.builtin")).toContain("module");
  });

  it("getPluginDocumentation parses ansible-doc JSON from stdout", async () => {
    const docPayload = {
      doc: { short_description: "Test module" },
      examples: "- name: ex",
    };
    runToolMock.mockImplementation(async (toolName: string, args: string[]) => {
      if (toolName === "ansible-doc") {
        const joined = args.join(" ");
        if (joined.includes("--metadata-dump")) {
          return { exitCode: 0, stdout: ansibleDocMetadata, stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: `warning: something\n${JSON.stringify({
            "ansible.builtin.copy": docPayload,
          })}`,
          stderr: "",
        };
      }
      if (toolName === "ade") {
        return { exitCode: 0, stdout: adeInspectStdout, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    });

    const svc = CollectionsService.getInstance();
    await svc.forceRefresh();

    const doc = await svc.getPluginDocumentation("ansible.builtin.copy", "module");
    expect(doc).not.toBeNull();
    expect(doc!.doc?.short_description).toBe("Test module");
    expect(doc!.examples).toBe("- name: ex");
  });
});
