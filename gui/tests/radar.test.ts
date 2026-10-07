import test from "node:test";
import assert from "node:assert/strict";
import { angleOf, radarBlips } from "../src/radar-blips.ts";
import type { Row } from "../src/types.ts";

const row = (owner: string, bucket: string) => ({ key: owner + bucket, owner, bucket }) as unknown as Row;

test("레이더: 역할마다 가장 급한 상태 하나, 같은 역할은 늘 같은 각도", () => {
  const blips = radarBlips({
    alerts: { items: [{ role: "a" }] },
    rows: [row("a", "stale"), row("b", "stuck"), row("b", "stale"), row("c", "stale"), row("d", "running"), row("", "stuck")],
    deadRoles: ["e"],
  });
  assert.deepEqual(blips.map((b) => [b.role, b.kind, b.r]), [["a", "alert", 0.82], ["e", "dead", 0.82], ["b", "stuck", 0.58], ["c", "stale", 0.36]]);
  assert.equal(angleOf("shop-작업자1"), angleOf("shop-작업자1"));
  assert.ok(blips.every((b) => b.angle >= 0 && b.angle < 360));
  assert.deepEqual(radarBlips({ alerts: null, rows: [] }), []);
  assert.equal(radarBlips({ alerts: null, rows: Array.from({ length: 40 }, (_, i) => row("r" + i, "stuck")) }, 24).length, 24);
});
