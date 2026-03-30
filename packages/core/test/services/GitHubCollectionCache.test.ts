import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubCollectionCache } from "../../src/services/GitHubCollectionCache";

function resetGitHubCacheSingleton(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (GitHubCollectionCache as any)._instance = undefined;
}

describe("GitHubCollectionCache", () => {
  let tmpHome: string;
  let cacheDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    resetGitHubCacheSingleton();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ansible-gh-cache-"));
    previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
    cacheDir = path.join(tmpHome, ".cache", "ansible-environments");
    fs.mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    resetGitHubCacheSingleton();
  });

  it("getInstance returns the same singleton", () => {
    const a = GitHubCollectionCache.getInstance();
    const b = GitHubCollectionCache.getInstance();
    expect(a).toBe(b);
  });

  it("loadFromDisk reads and parses cache file", () => {
    const org = "ansible";
    const payload = {
      org,
      lastUpdated: "2024-06-01T12:00:00.000Z",
      collections: [
        {
          namespace: "ansible",
          name: "posix",
          version: "1.5.0",
          description: "POSIX modules",
          repository: "ansible-collections/ansible.posix",
          org,
          htmlUrl: "https://github.com/ansible-collections/ansible.posix",
          installUrl: "git+https://github.com/ansible-collections/ansible.posix.git",
        },
      ],
    };
    fs.writeFileSync(path.join(cacheDir, `github-${org}.json`), JSON.stringify(payload), "utf-8");
    const svc = GitHubCollectionCache.getInstance();
    const loaded = svc.loadFromDisk(org);
    expect(loaded).toEqual(payload);
    expect(svc.getCollections(org)).toEqual(payload.collections);
  });

  it("loadFromDisk returns undefined for missing file", () => {
    const svc = GitHubCollectionCache.getInstance();
    expect(svc.loadFromDisk("nonexistent-org-xyz")).toBeUndefined();
  });

  it("loadFromDisk handles corrupted JSON gracefully", () => {
    const org = "badjson";
    fs.writeFileSync(path.join(cacheDir, `github-${org}.json`), "{ not valid json", "utf-8");
    const log = vi.fn();
    const svc = GitHubCollectionCache.getInstance();
    svc.setLogFunction(log);
    expect(svc.loadFromDisk(org)).toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("getCollections returns collections for a loaded org", () => {
    const org = "acme";
    const collections = [
      {
        namespace: "acme",
        name: "demo",
        version: "1.0.0",
        description: "Demo",
        repository: "acme/demo",
        org,
        htmlUrl: "https://github.com/acme/demo",
        installUrl: "git+https://github.com/acme/demo.git",
      },
    ];
    fs.writeFileSync(
      path.join(cacheDir, `github-${org}.json`),
      JSON.stringify({ org, collections, lastUpdated: "2024-01-01T00:00:00.000Z" }),
      "utf-8",
    );
    const svc = GitHubCollectionCache.getInstance();
    svc.loadFromDisk(org);
    expect(svc.getCollections(org)).toEqual(collections);
  });

  it("getCollections returns empty array for unknown org", () => {
    const svc = GitHubCollectionCache.getInstance();
    expect(svc.getCollections("unknown-org-123")).toEqual([]);
  });

  it("getAllCollections aggregates across orgs", () => {
    const svc = GitHubCollectionCache.getInstance();
    for (const org of ["orga", "orgb"]) {
      fs.writeFileSync(
        path.join(cacheDir, `github-${org}.json`),
        JSON.stringify({
          org,
          lastUpdated: "2024-01-01T00:00:00.000Z",
          collections: [
            {
              namespace: org,
              name: "foo",
              version: "1.0.0",
              description: `${org} foo`,
              repository: `${org}/foo`,
              org,
              htmlUrl: `https://github.com/${org}/foo`,
              installUrl: `git+https://github.com/${org}/foo.git`,
            },
          ],
        }),
        "utf-8",
      );
      svc.loadFromDisk(org);
    }
    const all = svc.getAllCollections();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((c) => c.repository))).toEqual(new Set(["orga/foo", "orgb/foo"]));
  });

  it("getCount returns correct count", () => {
    const org = "countme";
    fs.writeFileSync(
      path.join(cacheDir, `github-${org}.json`),
      JSON.stringify({
        org,
        lastUpdated: "2024-01-01T00:00:00.000Z",
        collections: [
          {
            namespace: "c",
            name: "one",
            version: "1.0.0",
            description: "",
            repository: "c/one",
            org,
            htmlUrl: "https://github.com/c/one",
            installUrl: "git+https://github.com/c/one.git",
          },
          {
            namespace: "c",
            name: "two",
            version: "1.0.0",
            description: "",
            repository: "c/two",
            org,
            htmlUrl: "https://github.com/c/two",
            installUrl: "git+https://github.com/c/two.git",
          },
        ],
      }),
      "utf-8",
    );
    const svc = GitHubCollectionCache.getInstance();
    svc.loadFromDisk(org);
    expect(svc.getCount(org)).toBe(2);
    expect(svc.getCount("missing")).toBe(0);
  });

  it("getLastUpdated returns date or undefined", () => {
    const org = "dated";
    const iso = "2024-03-15T08:30:00.000Z";
    fs.writeFileSync(
      path.join(cacheDir, `github-${org}.json`),
      JSON.stringify({ org, collections: [], lastUpdated: iso }),
      "utf-8",
    );
    const svc = GitHubCollectionCache.getInstance();
    svc.loadFromDisk(org);
    expect(svc.getLastUpdated(org)?.toISOString()).toBe(iso);
    expect(svc.getLastUpdated("nope")).toBeUndefined();
  });

  it("search matches by FQCN (namespace.name)", () => {
    const org = "searchfqcn";
    fs.writeFileSync(
      path.join(cacheDir, `github-${org}.json`),
      JSON.stringify({
        org,
        lastUpdated: "2024-01-01T00:00:00.000Z",
        collections: [
          {
            namespace: "myns",
            name: "widgets",
            version: "1.0.0",
            description: "Unrelated text",
            repository: "myns/widgets",
            org,
            htmlUrl: "https://github.com/myns/widgets",
            installUrl: "git+https://github.com/myns/widgets.git",
          },
        ],
      }),
      "utf-8",
    );
    const svc = GitHubCollectionCache.getInstance();
    svc.loadFromDisk(org);
    expect(svc.search("myns.widgets")).toHaveLength(1);
  });

  it("search matches by description", () => {
    const org = "searchdesc";
    fs.writeFileSync(
      path.join(cacheDir, `github-${org}.json`),
      JSON.stringify({
        org,
        lastUpdated: "2024-01-01T00:00:00.000Z",
        collections: [
          {
            namespace: "x",
            name: "y",
            version: "1.0.0",
            description: "Unique elephant phrase",
            repository: "x/y",
            org,
            htmlUrl: "https://github.com/x/y",
            installUrl: "git+https://github.com/x/y.git",
          },
        ],
      }),
      "utf-8",
    );
    const svc = GitHubCollectionCache.getInstance();
    svc.loadFromDisk(org);
    expect(svc.search("elephant")).toHaveLength(1);
  });

  it("search is case-insensitive", () => {
    const org = "casetest";
    fs.writeFileSync(
      path.join(cacheDir, `github-${org}.json`),
      JSON.stringify({
        org,
        lastUpdated: "2024-01-01T00:00:00.000Z",
        collections: [
          {
            namespace: "Big",
            name: "Small",
            version: "1.0.0",
            description: "MiXeD CaSe DeSc",
            repository: "Big/Small",
            org,
            htmlUrl: "https://github.com/Big/Small",
            installUrl: "git+https://github.com/Big/Small.git",
          },
        ],
      }),
      "utf-8",
    );
    const svc = GitHubCollectionCache.getInstance();
    svc.loadFromDisk(org);
    expect(svc.search("big.small")).toHaveLength(1);
    expect(svc.search("mixed case")).toHaveLength(1);
  });

  it("search returns empty for no matches", () => {
    const org = "nomatch";
    fs.writeFileSync(
      path.join(cacheDir, `github-${org}.json`),
      JSON.stringify({
        org,
        lastUpdated: "2024-01-01T00:00:00.000Z",
        collections: [
          {
            namespace: "a",
            name: "b",
            version: "1.0.0",
            description: "cd",
            repository: "a/b",
            org,
            htmlUrl: "https://github.com/a/b",
            installUrl: "git+https://github.com/a/b.git",
          },
        ],
      }),
      "utf-8",
    );
    const svc = GitHubCollectionCache.getInstance();
    svc.loadFromDisk(org);
    expect(svc.search("zzznomatchzzz")).toEqual([]);
  });

  it("_parseGalaxyYml parses galaxy.yml-shaped content (via private API)", () => {
    const svc = GitHubCollectionCache.getInstance();
    const yaml = `namespace: demo_ns
name: demo_name
version: 2.0.0
description: Parsed from YAML
`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const col = (svc as any)._parseGalaxyYml(yaml, "demo_org/demo_repo", "demo_org");
    expect(col).toEqual({
      namespace: "demo_ns",
      name: "demo_name",
      version: "2.0.0",
      description: "Parsed from YAML",
      repository: "demo_org/demo_repo",
      org: "demo_org",
      htmlUrl: "https://github.com/demo_org/demo_repo",
      installUrl: "git+https://github.com/demo_org/demo_repo.git",
    });
  });

  it("isRefreshing returns false when not refreshing", () => {
    const svc = GitHubCollectionCache.getInstance();
    expect(svc.isRefreshing("any-org")).toBe(false);
  });

  it("refresh no-ops when vscode is not available (standalone mode)", async () => {
    const log = vi.fn();
    const svc = GitHubCollectionCache.getInstance();
    svc.setLogFunction(log);
    await svc.refresh("some-org");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Cannot refresh some-org - not in VS Code context"),
    );
  });
});
