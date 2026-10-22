// kadan doctor — 읽기 전용 점검 (설치·상주 PR-1). 점검 본체는 src/doctor.mjs.
import os from "node:os";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { floor } from "../floor.mjs";
import { ledgerHome } from "../ledger.mjs";
import { sessionName, die } from "../cli-basics.mjs";
import { defaultProfilePath } from "../watch-profile.mjs";
import { readWatchProcesses } from "../watch-overview.mjs";
import { watchProcessName } from "../watch-system.mjs";
import { readBridgeStatus } from "./quickstart.mjs";
import { runDoctor, renderDoctor, doctorJson } from "../doctor.mjs";

const USAGE = "사용법: kadan doctor [--json]  (읽기 전용 점검. 아무것도 만들거나 고치지 않는다. 막힘이 있으면 종료 코드 1)";

export function cmdDoctor(argv, flags) {
  if (flags.help) { console.log(USAGE); return; }
  if (argv.length) die(USAGE, 2);
  const home = ledgerHome();
  const probes = {
    alive: (target) => target === "watch"
      ? readWatchProcesses(spawnSync, watchProcessName(home)).length > 0
      : floor.alive(sessionName(target)),
    watchProfile: () => fs.existsSync(defaultProfilePath(home)),
    bridgeStatus: () => readBridgeStatus(home),
  };
  const report = runDoctor({
    home, env: process.env, probes, run: spawnSync,
    repoRoot: new URL("../..", import.meta.url).pathname,
    cli: new URL("../cli.mjs", import.meta.url).pathname,
    userHome: os.homedir(), platform: process.platform,
    nodeVersion: process.versions.node, floorName: floor.name,
  });
  console.log(flags.json ? JSON.stringify(doctorJson(report), null, 2) : renderDoctor(report));
  if (report.exitCode) process.exitCode = report.exitCode;
}
