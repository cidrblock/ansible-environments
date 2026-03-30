import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const httpsGetMock = vi.hoisted(() => vi.fn());

vi.mock("https", () => ({
  get: httpsGetMock,
}));

import { GalaxyCollectionCache } from "../../src/services/GalaxyCollectionCache";

function resetGalaxySingleton(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (GalaxyCollectionCache as any)._instance = undefined;
}

function installMockGalaxyResponse(body: object): void {
  httpsGetMock.mockImplementation((_url: unknown, _options: unknown, cb: (res: EventEmitter) => void) => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = 200;

    const req = new EventEmitter() as EventEmitter & { destroy: () => void };
    req.destroy = vi.fn();

    queueMicrotask(() => {
      cb(res);
      queueMicrotask(() => {
        res.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
        res.emit("end");
      });
    });

    return req as ReturnType<typeof import("https").get>;
  });
}

function installMockGalaxySequence(
  responses: Array<{ statusCode: number; body: string }>,
): void {
  let index = 0;
  httpsGetMock.mockImplementation((_url: unknown, _options: unknown, cb: (res: EventEmitter) => void) => {
    const spec = responses[Math.min(index, responses.length - 1)];
    if (index < responses.length) {
      index += 1;
    }
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = spec.statusCode;

    const req = new EventEmitter() as EventEmitter & { destroy: () => void };
    req.destroy = vi.fn();

    queueMicrotask(() => {
      cb(res);
      queueMicrotask(() => {
        res.emit("data", Buffer.from(spec.body, "utf8"));
        res.emit("end");
      });
    });

    return req as ReturnType<typeof import("https").get>;
  });
}

describe("GalaxyCollectionCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ansible-galaxy-cache-"));
    resetGalaxySingleton();
    httpsGetMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetGalaxySingleton();
    httpsGetMock.mockReset();
  });

  it("getInstance returns the same singleton", () => {
    const a = GalaxyCollectionCache.getInstance();
    const b = GalaxyCollectionCache.getInstance();
    expect(a).toBe(b);
  });

  it("loads collections from disk when cache is fresh (TTL respected)", async () => {
    const storage = path.join(tmpDir, "globalStorage");
    fs.mkdirSync(storage, { recursive: true });

    const cache = {
      timestamp: Date.now(),
      collections: [
        {
          namespace: "community",
          name: "docker",
          version: "3.0.0",
          deprecated: false,
          downloadCount: 42,
        },
      ],
    };
    fs.writeFileSync(path.join(storage, "galaxy-collections-cache.json"), JSON.stringify(cache), "utf8");

    const svc = GalaxyCollectionCache.getInstance();
    svc.setExtensionContext({ globalStorageUri: { fsPath: storage } });

    await svc.ensureLoaded();

    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(svc.isLoaded()).toBe(true);
    const list = svc.getCollections();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      namespace: "community",
      name: "docker",
      version: "3.0.0",
      downloadCount: 42,
    });
  });

  it("ignores expired file cache and fetches from the API", async () => {
    const storage = path.join(tmpDir, "globalStorage2");
    fs.mkdirSync(storage, { recursive: true });

    const staleMs = 8 * 24 * 60 * 60 * 1000;
    const cache = {
      timestamp: Date.now() - staleMs,
      collections: [{ namespace: "old", name: "stale", version: "1", deprecated: false, downloadCount: 1 }],
    };
    fs.writeFileSync(path.join(storage, "galaxy-collections-cache.json"), JSON.stringify(cache), "utf8");

    const apiBody = {
      meta: { count: 1 },
      links: { next: null as string | null },
      data: [
        {
          namespace: "new",
          name: "fresh",
          deprecated: false,
          download_count: 9,
          highest_version: { version: "2.0.0" },
        },
      ],
    };
    installMockGalaxyResponse(apiBody);

    const svc = GalaxyCollectionCache.getInstance();
    svc.setExtensionContext({ globalStorageUri: { fsPath: storage } });

    await svc.ensureLoaded();

    expect(httpsGetMock).toHaveBeenCalled();
    expect(svc.getCollections().some((c) => c.name === "fresh")).toBe(true);
  });

  it("search filters by name, namespace, and fqcn; empty query returns top 100", async () => {
    const storage = path.join(tmpDir, "globalStorage3");
    fs.mkdirSync(storage, { recursive: true });

    const collections = Array.from({ length: 120 }, (_, i) => ({
      namespace: "ns",
      name: `coll${i}`,
      version: "1.0.0",
      deprecated: false,
      downloadCount: 200 - i,
    }));

    fs.writeFileSync(
      path.join(storage, "galaxy-collections-cache.json"),
      JSON.stringify({ timestamp: Date.now(), collections }),
      "utf8",
    );

    const svc = GalaxyCollectionCache.getInstance();
    svc.setExtensionContext({ globalStorageUri: { fsPath: storage } });
    await svc.ensureLoaded();

    const top = svc.search("");
    expect(top).toHaveLength(100);
    expect(top[0].downloadCount).toBeGreaterThanOrEqual(top[99].downloadCount);

    const filtered = svc.search("coll5");
    expect(filtered.every((c) => c.name.includes("coll5") || `${c.namespace}.${c.name}`.includes("coll5"))).toBe(
      true,
    );

    const byNs = svc.search("ns");
    expect(byNs.length).toBeGreaterThan(0);
  });

  it("forceRefresh clears state and repopulates from mocked HTTP", async () => {
    const storage = path.join(tmpDir, "globalStorage4");
    fs.mkdirSync(storage, { recursive: true });

    const apiBody = {
      meta: { count: 2 },
      links: { next: null as string | null },
      data: [
        {
          namespace: "a",
          name: "b",
          deprecated: false,
          download_count: 3,
          highest_version: { version: "1.2.3" },
        },
      ],
    };
    installMockGalaxyResponse(apiBody);

    const svc = GalaxyCollectionCache.getInstance();
    svc.setExtensionContext({ globalStorageUri: { fsPath: storage } });

    await svc.forceRefresh();

    expect(svc.isLoaded()).toBe(true);
    expect(svc.getCollections()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "a",
          name: "b",
          version: "1.2.3",
          downloadCount: 3,
        }),
      ]),
    );

    const written = fs.readFileSync(path.join(storage, "galaxy-collections-cache.json"), "utf8");
    const parsed = JSON.parse(written) as { timestamp: number; collections: unknown[] };
    expect(parsed.collections).toHaveLength(1);
    expect(typeof parsed.timestamp).toBe("number");
  });

  it("ensureLoaded is a no-op on second call when already loaded", async () => {
    const storage = path.join(tmpDir, "globalStorage-idem");
    fs.mkdirSync(storage, { recursive: true });
    const cache = {
      timestamp: Date.now(),
      collections: [{ namespace: "a", name: "b", version: "1", deprecated: false, downloadCount: 1 }],
    };
    fs.writeFileSync(path.join(storage, "galaxy-collections-cache.json"), JSON.stringify(cache), "utf8");

    const svc = GalaxyCollectionCache.getInstance();
    svc.setExtensionContext({ globalStorageUri: { fsPath: storage } });

    await svc.ensureLoaded();
    await svc.ensureLoaded();
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(svc.getCollections()).toHaveLength(1);
  });

  it("getCacheAge returns never before load and hour/day strings after API fetch", async () => {
    resetGalaxySingleton();
    const storage = path.join(tmpDir, "globalStorage-age");
    fs.mkdirSync(storage, { recursive: true });

    const svc = GalaxyCollectionCache.getInstance();
    svc.setExtensionContext({ globalStorageUri: { fsPath: storage } });
    expect(svc.getCacheAge()).toBe("never");

    installMockGalaxyResponse({
      meta: { count: 1 },
      links: { next: null as string | null },
      data: [
        {
          namespace: "n",
          name: "c",
          deprecated: false,
          download_count: 1,
          highest_version: { version: "1.0.0" },
        },
      ],
    });

    await svc.forceRefresh();
    expect(svc.getCacheAge()).toMatch(/just now|hour|day/);
  });

  it("fetches multiple pages when API returns relative next link", async () => {
    const storage = path.join(tmpDir, "globalStorage-pages");
    fs.mkdirSync(storage, { recursive: true });

    const page1 = {
      meta: { count: 200 },
      links: { next: "/api/v3/collections/?page=2" },
      data: [
        {
          namespace: "p1",
          name: "a",
          deprecated: false,
          download_count: 10,
          highest_version: { version: "1.0.0" },
        },
      ],
    };
    const page2 = {
      meta: { count: 200 },
      links: { next: null as string | null },
      data: [
        {
          namespace: "p2",
          name: "b",
          deprecated: false,
          download_count: 20,
          highest_version: { version: "2.0.0" },
        },
      ],
    };

    let call = 0;
    httpsGetMock.mockImplementation((url: unknown, _options: unknown, cb: (res: EventEmitter) => void) => {
      const body = call++ === 0 ? page1 : page2;
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;
      const req = new EventEmitter() as EventEmitter & { destroy: () => void };
      req.destroy = vi.fn();
      queueMicrotask(() => {
        cb(res);
        queueMicrotask(() => {
          res.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
          res.emit("end");
        });
      });
      return req as ReturnType<typeof import("https").get>;
    });

    const svc = GalaxyCollectionCache.getInstance();
    svc.setExtensionContext({ globalStorageUri: { fsPath: storage } });
    await svc.forceRefresh();

    expect(httpsGetMock).toHaveBeenCalledTimes(2);
    const names = svc.getCollections().map((c) => `${c.namespace}.${c.name}`).sort();
    expect(names).toEqual(["p1.a", "p2.b"]);
  });

  it("retries HTTP 500 then succeeds", async () => {
    const storage = path.join(tmpDir, "globalStorage-retry");
    fs.mkdirSync(storage, { recursive: true });

    const okBody = {
      meta: { count: 1 },
      links: { next: null as string | null },
      data: [
        {
          namespace: "ok",
          name: "ns",
          deprecated: false,
          download_count: 1,
          highest_version: { version: "1.0.0" },
        },
      ],
    };

    installMockGalaxySequence([
      { statusCode: 500, body: "err" },
      { statusCode: 200, body: JSON.stringify(okBody) },
    ]);

    vi.useFakeTimers();
    const svc = GalaxyCollectionCache.getInstance();
    svc.setExtensionContext({ globalStorageUri: { fsPath: storage } });
    const p = svc.forceRefresh();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    vi.useRealTimers();

    expect(httpsGetMock).toHaveBeenCalledTimes(2);
    expect(svc.getCollections().some((c) => c.name === "ns")).toBe(true);
  });

  it("getProgress and onDidUpdateProgress fire during fetch", async () => {
    const storage = path.join(tmpDir, "globalStorage-prog");
    fs.mkdirSync(storage, { recursive: true });

    const body = {
      meta: { count: 1 },
      links: { next: null as string | null },
      data: [
        {
          namespace: "x",
          name: "y",
          deprecated: false,
          download_count: 5,
          highest_version: { version: "1.0.0" },
        },
      ],
    };
    installMockGalaxyResponse(body);

    const svc = GalaxyCollectionCache.getInstance();
    svc.setExtensionContext({ globalStorageUri: { fsPath: storage } });

    const progress: Array<{ loaded: number; total: number }> = [];
    const sub = svc.onDidUpdateProgress((e: { loaded: number; total: number }) => progress.push(e));

    await svc.forceRefresh();
    sub.dispose?.();

    expect(progress.length).toBeGreaterThan(0);
    expect(svc.getProgress().loaded).toBeGreaterThan(0);
  });

  it("ignores invalid on-disk cache shape and fetches from API", async () => {
    const storage = path.join(tmpDir, "globalStorage-bad");
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(path.join(storage, "galaxy-collections-cache.json"), '{"timestamp":1}', "utf8");

    installMockGalaxyResponse({
      meta: { count: 1 },
      links: { next: null },
      data: [
        {
          namespace: "fresh",
          name: "api",
          deprecated: false,
          download_count: 1,
          highest_version: { version: "1.0.0" },
        },
      ],
    });

    const svc = GalaxyCollectionCache.getInstance();
    svc.setExtensionContext({ globalStorageUri: { fsPath: storage } });
    await svc.ensureLoaded();

    expect(httpsGetMock).toHaveBeenCalled();
    expect(svc.getCollections().some((c) => c.namespace === "fresh")).toBe(true);
  });

  it("startBackgroundLoad kicks off fetch without awaiting", async () => {
    const storage = path.join(tmpDir, "globalStorage-bg");
    fs.mkdirSync(storage, { recursive: true });

    let released!: () => void;
    const gate = new Promise<void>((r) => {
      released = r;
    });

    httpsGetMock.mockImplementation((_url: unknown, _options: unknown, cb: (res: EventEmitter) => void) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;
      const req = new EventEmitter() as EventEmitter & { destroy: () => void };
      req.destroy = vi.fn();
      void gate.then(() => {
        queueMicrotask(() => {
          cb(res);
          queueMicrotask(() => {
            res.emit(
              "data",
              Buffer.from(
                JSON.stringify({
                  meta: { count: 1 },
                  links: { next: null },
                  data: [
                    {
                      namespace: "bg",
                      name: "c",
                      deprecated: false,
                      download_count: 1,
                      highest_version: { version: "1.0.0" },
                    },
                  ],
                }),
                "utf8",
              ),
            );
            res.emit("end");
          });
        });
      });
      return req as ReturnType<typeof import("https").get>;
    });

    const svc = GalaxyCollectionCache.getInstance();
    svc.setExtensionContext({ globalStorageUri: { fsPath: storage } });
    svc.startBackgroundLoad();
    await vi.waitUntil(() => svc.isLoading() || svc.isLoaded(), { timeout: 2000 });
    released();
    await vi.waitUntil(() => svc.isLoaded(), { timeout: 3000 });
    expect(svc.getCollections().some((c) => c.name === "c")).toBe(true);
  });
});
