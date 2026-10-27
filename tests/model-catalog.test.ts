import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("same-origin model catalog cache", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetches publicly without credentials and caches for ten minutes", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const value = { data: [{ id: "test:free", pricing: { prompt: "0", completion: "0" } }] };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(value)));
    const { getModelCatalog } = await import("../server/model-catalog");
    expect(await getModelCatalog()).toEqual(value);
    now += 599_999;
    expect(await getModelCatalog()).toEqual(value);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models");
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Accept: "application/json" });
    now += 1;
    expect(await getModelCatalog()).toEqual(value);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces simultaneous fetches", async () => {
    fetchMock.mockImplementation(async () => new Response('{"data":[]}'));
    const { getModelCatalog } = await import("../server/model-catalog");
    await Promise.all([getModelCatalog(), getModelCatalog(), getModelCatalog()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures or invalid upstream data", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"wrong":true}'))
      .mockResolvedValueOnce(new Response('{"data":[]}'));
    const { getModelCatalog } = await import("../server/model-catalog");
    await expect(getModelCatalog()).rejects.toThrow("HTTP 503");
    await expect(getModelCatalog()).rejects.toThrow("invalid model list");
    expect(await getModelCatalog()).toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
