/** A fake `fetch` that replays queued responses and records requests. */

import { OxfordAPI, type ClientOptions } from "../src/index.js";

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

export interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: any;
  redirect?: RequestRedirect;
}

export const TOP = {
  Online: true,
  LastHeartbeat: 100,
  NextHeartbeat: 101,
  Cursor: 50,
  Server: { Name: "Test RP" },
};

export const OK = { CommandId: "c", Status: "Succeeded", Code: "OK", Message: "Done" };

export function ok(body: unknown, headers?: Record<string, string>): Reply {
  return { status: 200, body, headers };
}

export function fakeFetch(replies: Reply[] | ((call: Call) => Reply)) {
  const calls: Call[] = [];
  const queue = Array.isArray(replies) ? [...replies] : undefined;
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      redirect: init.redirect,
    };
    calls.push(call);
    const reply = queue ? queue.shift() : (replies as (c: Call) => Reply)(call);
    if (!reply) throw new Error(`No more fake responses (request ${calls.length}: ${call.method} ${call.url})`);
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    const noBody = status === 304 || reply.body === undefined;
    return new Response(noBody ? null : JSON.stringify(reply.body), { status, headers: reply.headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

export function client(replies: Reply[], options: Partial<ClientOptions> = {}) {
  const { fetch, calls } = fakeFetch(replies);
  const api = new OxfordAPI({ serverKey: "sk_test", rateLimit: "none", fetch, ...options });
  return { api, calls };
}

export function kills(cursor: number, ...seqs: number[]) {
  return { ...TOP, Cursor: cursor, KillLogs: [...seqs].sort((a, b) => b - a).map((Seq) => ({ Seq, Type: "Kill" })) };
}
