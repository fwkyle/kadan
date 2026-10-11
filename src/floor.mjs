import { tmuxFloor } from "./floor-tmux.mjs";
import { rottieFloor } from "./floor-rottie.mjs";
import { herdrFloor } from "./floor-herdr.mjs";

export function selectFloorName(value = "tmux") {
  if (value === "tmux") return tmuxFloor;
  if (value === "rottie") return rottieFloor;
  if (value === "herdr") return herdrFloor;
  const error = new Error(
    `KADAN_FLOOR_INVALID: KADAN_FLOOR=${value} (tmux|rottie|herdr만 허용)`
  );
  error.code = "KADAN_FLOOR_INVALID";
  error.exitCode = 2;
  throw error;
}

export const floor = (() => {
  try {
    return selectFloorName(process.env.KADAN_FLOOR || "tmux");
  } catch (error) {
    console.error(`오류: ${error.message}`);
    process.exit(error.exitCode || 1);
  }
})();
