import { vi } from "vitest";

type FetchCall = [input: string | URL | Request, init: RequestInit | undefined];

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function makeFetch(responses: Response[]) {
  const calls: FetchCall[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push([input, init]);
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  });
  return { fetch, calls };
}

export function makeThrowingFetch(responses: Array<Response | Error>) {
  const fetch = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    if (response instanceof Error) throw response;
    return response;
  });
  return { fetch };
}

