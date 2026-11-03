import test from "node:test";
import assert from "node:assert/strict";
import { carryRepo, repoHref, repoSwitchUrl } from "../src/repo-nav.ts";
import { alertMore } from "../src/stopped.ts";

test("주 메뉴 주소: repo가 있으면 모든 메뉴 링크에 붙고, 없으면 그대로", () => {
  assert.equal(repoHref("#status", null), "#status");
  assert.equal(repoHref("#status", "kadan"), "/?repo=kadan#status");
  assert.equal(repoHref("/?collection=work#dashboard", "kadan"), "/?collection=work&repo=kadan#dashboard");
  assert.equal(repoHref("#kanban", "저장소 모름"), "/?repo=%EC%A0%80%EC%9E%A5%EC%86%8C+%EB%AA%A8%EB%A6%84#kanban");
});

test("화면 안 링크: 지금 repo를 이어 붙이고, 이미 있거나 '전체'(clear)면 건드리지 않는다", () => {
  const t = new URL("http://x/?collection=work#dashboard");
  assert.equal(carryRepo(t, "kadan").searchParams.get("repo"), "kadan");
  assert.equal(carryRepo(t, null).href, t.href);
  assert.equal(carryRepo(t, "kadan", true).href, t.href);
  const own = new URL("http://x/?repo=other#status");
  assert.equal(carryRepo(own, "kadan").searchParams.get("repo"), "other");
});

test("사이드 탭 전환: 화면(해시)은 유지하고 repo만 바꾸며 '전체'는 repo를 지운다", () => {
  const from = new URL("http://x/?repo=a&page=3&group=owner#kanban");
  assert.equal(repoSwitchUrl(from, "b"), "/?repo=b&group=owner#kanban");
  assert.equal(repoSwitchUrl(from, null), "/?group=owner#kanban");
});

test("경보 나머지 수 경계(20/21): 요약 숫자와 목록 건수가 어긋나면 그 차이를 밝힌다", () => {
  assert.deepEqual(alertMore(20, 20), { total: 15, listed: 15, unlisted: 0 });
  assert.deepEqual(alertMore(21, 20), { total: 16, listed: 15, unlisted: 1 });
  assert.deepEqual(alertMore(5, 5), { total: 0, listed: 0, unlisted: 0 });
});
