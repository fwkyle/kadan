import test from "node:test";
import assert from "node:assert/strict";
import {createJsonLoader} from "../src/resource-http.ts";

test("ETag로 같은 자료를 재사용하고 강제 갱신은 조건 없이 새로 읽는다", async () => {
  const requests: {url: string; init?: RequestInit}[] = [];
  const replies = [new Response('{"n":1}', {headers: {etag: 'W/"one"'}}),
    new Response(null, {status: 304}), new Response('{"n":2}', {headers: {etag: 'W/"two"'}})];
  const load = createJsonLoader<{n: number}>("/api/dashboard/summary?x=1", async (url, init) => {
    requests.push({url: String(url), init});
    return replies.shift()!;
  });
  const signal = new AbortController().signal;
  const first = await load(signal);
  assert.strictEqual(await load(signal), first);
  assert.equal(new Headers(requests[1].init?.headers).get("if-none-match"), 'W/"one"');
  assert.deepEqual(await load(signal, true), {n: 2});
  assert.equal(requests[2].url, "/api/dashboard/summary?x=1&fresh=1");
  assert.equal(new Headers(requests[2].init?.headers).has("if-none-match"), false);
});

test("뒤늦은 옛 요청은 새 ETag를 덮지 않는다", async () => {
  let release!: (r: Response) => void;
  const old = new Promise<Response>(resolve => { release = resolve; });
  let calls = 0, lastHeaders: Headers | null = null;
  const load = createJsonLoader<{n: number}>("/api/dashboard/summary", async (_url, init) => {
    calls++;
    if (calls === 1) return old;
    if (calls === 2) return new Response('{"n":2}', {headers: {etag: 'W/"new"'}});
    lastHeaders = new Headers(init?.headers);
    return new Response(null, {status: 304});
  });
  const controller = new AbortController();
  const pending = load(controller.signal);
  controller.abort();
  const latest = await load(new AbortController().signal, true);
  release(new Response('{"n":1}', {headers: {etag: 'W/"old"'}}));
  await pending;
  assert.strictEqual(await load(new AbortController().signal), latest);
  assert.equal((lastHeaders as Headers | null)?.get("if-none-match"), 'W/"new"');
});

test("캐시 없는 304와 조회 실패를 정상 빈 결과로 숨기지 않는다", async () => {
  const signal = new AbortController().signal;
  const missing = createJsonLoader("/api/dashboard/summary", async () => new Response(null, {status: 304}));
  await assert.rejects(missing(signal), /이전 자료 없이/);
  const failed = createJsonLoader("/api/dashboard/summary", async () => new Response("실패", {status: 503}));
  await assert.rejects(failed(signal), /실패/);
});
