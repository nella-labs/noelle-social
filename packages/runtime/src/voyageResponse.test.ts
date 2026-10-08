import { afterEach, describe, expect, it, vi } from "vitest";
import { voyageEmbed } from "./voyageEmbed.js";
import { voyageContextEmbed } from "./voyageContextEmbed.js";
import { voyageRerank, rankStyleExemplars } from "./voyageRerank.js";
import { hybridRankStyleExemplars } from "./hybridRank.js";

afterEach(() => { vi.unstubAllGlobals(); });
const response = (data: unknown) => ({ apiKey: "fixture-key", fetchImpl: vi.fn(async () => Response.json({ data })) });
describe("Voyage response boundaries", () => {
  it("does not return sparse embeddings after a fractional provider index", async () => {
    expect(await voyageEmbed(["one", "two"], response([
      { index: 0.5, embedding: [1, 2] }, { index: 1, embedding: [3, 4] },
    ]))).toEqual([]);
  });
  it("does not return sparse contextual chunks after a fractional provider index", async () => {
    expect(await voyageContextEmbed([["one", "two"]], response([{ index: 0, data: [
      { index: 0.5, embedding: [1, 2] }, { index: 1, embedding: [3, 4] },
    ] }]))).toEqual([]);
  });
  it.each([{ embedding: ["number"] }, { embedding: [null] }, { embedding: [true] }])("refuses nonnumeric ordinary and contextual vectors %j", async ({ embedding }) => {
    expect(await voyageEmbed(["one"], response([{ index: 0, embedding }]))).toEqual([]);
    expect(await voyageContextEmbed([["one"]], response([{ index: 0, data: [{ index: 0, embedding }] }]))).toEqual([]);
  });
  it("refuses infinite vector components decoded from a numeric JSON exponent", async () => {
    const fetchImpl = async () => new Response('{"data":[{"index":0,"embedding":[1e309]}]}');
    expect(await voyageEmbed(["one"], { apiKey: "fixture-key", fetchImpl })).toEqual([]);
  });
  it.each([
    { rows: [{ index: 0.5, relevance_score: 0.9 }, { index: 1, relevance_score: 0.8 }] },
    { rows: [{ index: 1, relevance_score: 0.9 }, { index: 1, relevance_score: 0.8 }] },
  ])("falls back to the complete identity ranking for invalid/duplicate rerank rows %j", async ({ rows }) => {
    expect((await voyageRerank("query", ["one", "two"], response(rows))).map(row => row.index)).toEqual([0, 1]);
  });
  it("refuses infinite rerank scores", async () => {
    const fetchImpl = async () => new Response('{"data":[{"index":1,"relevance_score":1e309}]}');
    expect((await voyageRerank("query", ["one", "two"], { apiKey: "fixture-key", fetchImpl })).map(row => row.index)).toEqual([0, 1]);
  });
  it("enforces topK locally when the provider sends more rows", async () => {
    expect(await voyageRerank("query", ["one", "two"], { ...response([
      { index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 },
    ]), topK: 1 })).toEqual([{ index: 1, score: 0.9 }]);
  });
  it.each([0, -1, 1.5, NaN, Infinity])("does not dispatch an invalid/empty topK %s", async topK => {
    const options = response([{ index: 0, relevance_score: 0.8 }]);
    expect(await voyageRerank("query", ["one", "two"], { ...options, topK })).toEqual([]);
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });
  it("keeps omitted style candidates in input order after the received ranking", async () => {
    const candidates = ["one", "two", "three"];
    const options = response([{ index: 2, relevance_score: 0.9 }]);
    expect(await rankStyleExemplars("query", candidates, c => c, options)).toEqual(["three", "one", "two"]);
    expect(await rankStyleExemplars("query", candidates, c => c, { ...options, topK: 2 })).toEqual(["three", "one"]);
  });
  it("preserves candidates missing both dense vectors and partial rerank rows", async () => {
    const candidates = [{ text: "one", embedding: [1] }, { text: "two" }, { text: "three" }];
    const fetchImpl: typeof fetch = async url => Response.json({ data: String(url).endsWith("/embeddings")
      ? [{ index: 0, embedding: [1] }] : [{ index: 0, relevance_score: 0.9 }] });
    const result = await hybridRankStyleExemplars("query", candidates, {
      apiKey: "fixture-key", fetchImpl, toText: c => c.text, toEmbedding: c => c.embedding,
    });
    expect(result).toEqual(candidates);
  });
  it.each([0, -1, 1.5, NaN, Infinity])("does not embed or rerank an invalid hybrid topK %s", async topK => {
    const options = response([{ index: 0, embedding: [1] }]);
    expect(await hybridRankStyleExemplars("query", ["one", "two"], {
      ...options, topK, toText: c => c, toEmbedding: () => [1],
    })).toEqual([]);
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });
});
