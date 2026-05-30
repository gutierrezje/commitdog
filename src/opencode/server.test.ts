import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  fetch: vi.fn(),
  writeFile: vi.fn(),
  ensureDiffOwlDir: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: mocks.execa,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    writeFile: mocks.writeFile,
  };
});

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  return {
    ...actual,
    ensureDiffOwlDir: mocks.ensureDiffOwlDir,
  };
});

describe("ensureServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "fetch");
  });

  it("handles fast detached server exits through the health-check failure path", async () => {
    vi.useFakeTimers();
    const { ensureServer } = await import("./server.js");
    const child = Promise.reject(new Error("serve failed")) as Promise<never> & {
      pid: number;
      unref: () => void;
    };
    child.pid = 12345;
    child.unref = vi.fn();

    mocks.ensureDiffOwlDir.mockResolvedValue("/tmp/diffowl");
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.execa
      .mockResolvedValueOnce({ stdout: "/usr/local/bin/opencode" })
      .mockReturnValueOnce(child);
    mocks.fetch.mockRejectedValue(new Error("not running"));
    vi.stubGlobal("fetch", mocks.fetch);

    const result = expect(ensureServer(4096)).rejects.toThrow(
      "Failed to start OpenCode server on port 4096",
    );
    await vi.runAllTimersAsync();

    await result;
    expect(child.unref).toHaveBeenCalled();
  });
});
