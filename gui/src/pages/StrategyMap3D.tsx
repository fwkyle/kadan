import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { shortName, worldLayout, type Base, type Unit, type UnitState, type WorldBase } from "../strategy-map";

// 전략 맵 3D 보기(2026-10-06 [kyle] 2단계). 자료 해석은 2D와 같은 strategy-map.ts를 쓰고, 여기서는 그리기만 한다.
// 이 파일은 3D 탭을 열 때만 불러온다(React.lazy) — three.js가 다른 화면의 첫 로딩을 늦추지 않게.
// 상시 띄워 두는 대시보드라 화면은 바뀔 때만 다시 그린다(frameloop="demand"). 작업중 유닛의 흔들림만 초당 20장으로 돌린다.
type Props = { bases: Base[]; depot: number; showResting: boolean; selected: string | null; depotKey: string; onSelect: (key: string) => void };

const STATES: UnitState[] = ["dead", "stuck", "running", "stale", "idle", "unknown", "off"];
const CRATES = ["running", "stuck", "stale", "planned"] as const;
type Palette = Record<string, string>;

// 색은 2D와 같은 style.css 규칙에서 읽는다. 숨긴 SVG 표본에 2D 클래스를 달고 계산된 색을 가져오므로 다크 모드 변환도 그대로 따른다.
function Probe({ onRead }: { onRead: (p: Palette) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const read = () => {
      const p: Palette = {};
      ref.current?.querySelectorAll<SVGElement>("[data-k]").forEach((el) => {
        const css = getComputedStyle(el);
        p[el.dataset.k!] = el.dataset.stroke ? css.stroke : css.fill;
      });
      onRead(p);
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", read);
    return () => { watch.disconnect(); media.removeEventListener("change", read); };
  }, [onRead]);
  return <svg ref={ref} className="sm-probe" aria-hidden="true" focusable="false">
    {STATES.map((s) => <g key={s} className={"sm-s-" + s}><path className="sm-body" data-k={"s-" + s} /></g>)}
    {CRATES.map((c) => <g key={c} className={"sm-c-" + c}><polygon className="sm-crate-left" data-k={"c-" + c} /></g>)}
    <polygon className="sm-plat-top" data-k="plat" /><polygon className="sm-plat-top sm-plat-outside" data-k="outside" />
    <polygon className="sm-plat-right" data-k="side" /><ellipse className="sm-tile" data-k="tile" />
    <path className="sm-crown" data-k="crown" /><g className="sm-flag"><path data-k="flag" /><line data-k="pole" data-stroke="1" /></g>
    <text className="sm-label" data-k="label" /><text className="sm-base-label" data-k="baseLabel" />
    <ellipse className="sm-ring" data-k="ring" data-stroke="1" />
  </svg>;
}

// 글자 이름표: 캔버스에 글을 그려 늘 카메라를 보는 판(sprite)으로 붙인다. 3D 글꼴 라이브러리를 더하지 않기 위해서다.
function Label({ text, color, at, height = 0.36, weight = 650, disc }: { text: string; color: string; at: [number, number, number]; height?: number; weight?: number; disc?: string }) {
  const { texture, aspect } = useMemo(() => {
    const size = 44, pad = disc ? 10 : 12, canvas = document.createElement("canvas"), ctx = canvas.getContext("2d")!;
    const font = `${weight} ${size}px system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif`;
    ctx.font = font;
    const w = disc ? size + pad * 2 : Math.ceil(ctx.measureText(text).width) + pad * 2, h = size + pad * 2;
    canvas.width = w; canvas.height = h;
    if (disc) { ctx.fillStyle = disc; ctx.beginPath(); ctx.arc(w / 2, h / 2, h / 2 - 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2, h / 2 + 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return { texture, aspect: w / h };
  }, [text, color, weight, disc]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <sprite position={at} scale={[height * aspect, height, 1]} renderOrder={10}>
    <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} />
  </sprite>;
}

// 누르기와 끌기(시점 돌리기)를 가른다. 손이 5px 넘게 움직였으면 고르지 않는다.
function pick(onSelect: () => void) {
  return {
    onClick: (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); if (e.delta <= 5) onSelect(); },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); (e.nativeEvent.target as HTMLElement).style.cursor = "pointer"; },
    onPointerOut: (e: ThreeEvent<PointerEvent>) => { (e.nativeEvent.target as HTMLElement).style.cursor = ""; },
  };
}

function Crate({ at, color }: { at: [number, number, number]; color: string }) {
  return <mesh position={at} castShadow><boxGeometry args={[0.18, 0.18, 0.18]} /><meshLambertMaterial color={color} /></mesh>;
}
function crateKinds(unit: Unit) {
  const kinds: string[] = [];
  for (const k of ["stuck", "running", "stale", "planned", "hold"] as const)
    for (let i = 0; i < unit.crates[k]; i++) kinds.push(k === "hold" ? "planned" : k);
  return kinds;
}

function UnitFigure({ unit, x, z, base, palette, selected, motion, onSelect }: { unit: Unit; x: number; z: number; base: Base; palette: Palette; selected: boolean; motion: boolean; onSelect: () => void }) {
  const figure = useRef<THREE.Group>(null);
  const bob = motion && unit.state === "running";
  useFrame(({ clock }) => { if (figure.current) figure.current.position.y = bob ? (Math.sin(clock.elapsedTime * 3.9) + 1) * 0.04 : 0; });
  const scale = unit.kind === "super" ? 1.3 : unit.kind === "director" ? 1.12 : 1;
  const color = palette["s-" + unit.state], dead = unit.state === "dead";
  const crates = crateKinds(unit), shown = crates.slice(0, 4), name = shortName(unit.role, base.super);
  const badge = dead ? "✕" : unit.state === "stuck" || unit.alerts ? "!" : null;
  const badgeDisc = dead ? palette["s-dead"] : unit.state === "stuck" ? palette["s-stuck"] : "#ffffff";
  return <group position={[x, 0, z]} {...pick(onSelect)}>
    <mesh position={[0, 0.7, 0]}><cylinderGeometry args={[0.55, 0.55, 1.4, 12]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
    <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[0.62, 32]} /><meshLambertMaterial color={palette.tile} /></mesh>
    {selected && <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.5, 0.6, 40]} /><meshBasicMaterial color={palette.ring} /></mesh>}
    <group ref={figure}>
      <group scale={scale}>
        <mesh position={[0, 0.35, 0]} castShadow><capsuleGeometry args={[0.19, 0.32, 6, 16]} /><meshLambertMaterial color={color} transparent={dead} opacity={dead ? 0.55 : 1} /></mesh>
        <mesh position={[0, 0.86, 0]} castShadow><sphereGeometry args={[0.16, 20, 14]} /><meshLambertMaterial color={color} transparent={dead} opacity={dead ? 0.55 : 1} /></mesh>
        {unit.kind === "super" && <mesh position={[0, 1.1, 0]} castShadow><coneGeometry args={[0.15, 0.2, 5]} /><meshLambertMaterial color={palette.crown} /></mesh>}
        {unit.kind === "director" && <group position={[0.27, 0, 0]}>
          <mesh position={[0, 0.6, 0]} castShadow><cylinderGeometry args={[0.014, 0.014, 1.2, 6]} /><meshLambertMaterial color={palette.pole} /></mesh>
          <mesh position={[0.13, 1.1, 0]} castShadow><boxGeometry args={[0.24, 0.15, 0.02]} /><meshLambertMaterial color={palette.flag} /></mesh>
        </group>}
      </group>
    </group>
    {badge && <Label text={badge} color={badgeDisc === "#ffffff" ? palette.label : "#ffffff"} disc={badgeDisc} weight={800} height={0.32} at={[0.24 * scale, 1.38 * scale, 0]} />}
    {shown.map((kind, i) => <Crate key={i} color={palette["c-" + kind]} at={[0.42 + (i % 2) * 0.2, 0.09 + Math.floor(i / 2) * 0.19, 0.12]} />)}
    {crates.length > shown.length && <Label text={"+" + (crates.length - shown.length)} color={palette.baseLabel} height={0.2} at={[0.72, 0.3, 0.12]} />}
    <Label text={name.length > 11 ? name.slice(0, 10) + "…" : name} color={palette.label} at={[0, 0.02, 0.62]} />
  </group>;
}

function BaseBlock({ world, palette, selected, motion, onSelect }: { world: WorldBase; palette: Palette; selected: string | null; motion: boolean; onSelect: (key: string) => void }) {
  const { base, x0, x1, depth, units, resting } = world, w = x1 - x0, edge = 0.3;
  return <group>
    <mesh position={[x0 + w / 2, -0.14, depth / 2]} receiveShadow>
      <boxGeometry args={[w + edge, 0.28, depth + edge]} />
      <meshLambertMaterial color={base.super ? palette.plat : palette.outside} />
    </mesh>
    {units.map(({ unit, x, z }) => <UnitFigure key={unit.role} unit={unit} x={x} z={z} base={base} palette={palette} motion={motion}
      selected={selected === unit.role} onSelect={() => onSelect(unit.role)} />)}
    <Label text={`${base.label} · 유닛 ${units.length}${resting ? ` (쉬는 ${resting})` : ""}`} color={palette.baseLabel} weight={750} height={0.42}
      at={[x0 + w / 2, -0.1, depth + edge + 0.45]} />
  </group>;
}

function Depot({ at, count, palette, selected, onSelect }: { at: { x: number; z: number }; count: number; palette: Palette; selected: boolean; onSelect: () => void }) {
  return <group position={[at.x, 0, at.z]} {...pick(onSelect)}>
    <mesh position={[0, 0.5, 0]}><boxGeometry args={[1.2, 1, 1.2]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
    <mesh position={[0, -0.1, 0]} receiveShadow><boxGeometry args={[1.25, 0.2, 1.25]} /><meshLambertMaterial color={palette.outside} /></mesh>
    {selected && <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.62, 0.72, 40]} /><meshBasicMaterial color={palette.ring} /></mesh>}
    {[[-0.2, 0.09, -0.1], [0, 0.09, 0.12], [0.2, 0.09, -0.1], [-0.1, 0.28, 0], [0.1, 0.28, 0]].map((p, i) =>
      <Crate key={i} color={palette["c-planned"]} at={p as [number, number, number]} />)}
    <Label text={`발령 전 창고 ${count}`} color={palette.baseLabel} weight={750} height={0.42} at={[0, -0.1, 1.05]} />
  </group>;
}

// 장면 크기에 맞춰 시점을 잡는다. 기지 배치가 바뀌거나 '시점 되돌리기'를 누를 때만 다시 잡아, 사람이 돌려 둔 시점을 자료 갱신마다 흔들지 않는다.
function Rig({ size, fitKey }: { size: { x: number; z: number }; fitKey: string }) {
  const { camera, gl, invalidate } = useThree();
  const view = useThree((s) => s.size);
  const controls = useRef<OrbitControls | null>(null);
  useEffect(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.maxPolarAngle = Math.PI * 0.46; c.minDistance = 3; c.maxDistance = 120;
    const redraw = () => invalidate();
    c.addEventListener("change", redraw);
    controls.current = c;
    return () => { c.removeEventListener("change", redraw); c.dispose(); };
  }, [camera, gl, invalidate]);
  useEffect(() => {
    const c = controls.current, cam = camera as THREE.PerspectiveCamera;
    if (!c) return;
    cam.aspect = view.width / Math.max(1, view.height); cam.updateProjectionMatrix();
    // 장면은 원점 중심으로 옮겨 그린다. 이름표 자리까지 포함한 바닥 상자의 모서리가 화면 안(가장자리 8% 여백)에 들도록
    // 가장 가까운 거리를 반씩 좁혀 찾는다 — 비스듬한 시점이라 계산식 하나로는 한쪽이 잘리거나 너무 멀어진다.
    const center = new THREE.Vector3(0, 0.4, 0), dir = new THREE.Vector3(0.1, 0.85, 1).normalize();
    // 역할이 몇 안 되는 작은 장면도 최소 이만큼은 담는다 — 너무 다가가면 이름표가 커져 기지 밖으로 넘친다(2026-10-06 실자료 3유닛).
    const hx = Math.max(size.x / 2 + 0.2, 7), hz = Math.max(size.z / 2 + 0.6, 3);
    // 바닥 네 모서리와 뒤쪽 위(맨 안쪽 줄 유닛의 머리 높이)만 본다. 앞쪽 위 모서리는 비어 있는데 카메라에 가까워 너무 넓게 잡힌다.
    const corners = [-hx, hx].flatMap((x) => [new THREE.Vector3(x, 0, -hz), new THREE.Vector3(x, 0, hz), new THREE.Vector3(x, 1.5, -hz)]);
    const fits = (d: number) => {
      cam.position.copy(center).addScaledVector(dir, d); cam.lookAt(center); cam.updateMatrixWorld();
      return corners.every((p) => { const v = p.clone().project(cam); return Math.abs(v.x) <= 0.97 && Math.abs(v.y) <= 0.88 && v.z < 1; });
    };
    let near = 2, far = 300;
    for (let i = 0; i < 30; i++) { const mid = (near + far) / 2; if (fits(mid)) far = mid; else near = mid; }
    fits(far);
    c.target.copy(center); c.update(); invalidate();
  }, [fitKey, view.width, view.height, camera, invalidate]);
  return null;
}

function Ticker({ on }: { on: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => { if (!on) return; const id = setInterval(() => invalidate(), 50); return () => clearInterval(id); }, [on, invalidate]);
  return null;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)"), on = () => setReduced(media.matches);
    media.addEventListener("change", on); return () => media.removeEventListener("change", on);
  }, []);
  return reduced;
}

export default function StrategyMap3D({ bases, depot, showResting, selected, depotKey, onSelect }: Props) {
  const [palette, setPalette] = useState<Palette | null>(null);
  const [resetCount, setResetCount] = useState(0);
  const motion = !useReducedMotion();
  const world = worldLayout(bases, depot, showResting);
  const fitKey = `${world.size.x.toFixed(1)}x${world.size.z.toFixed(1)}#${resetCount}`;
  const animate = motion && world.bases.some((b) => b.units.some((u) => u.unit.state === "running"));
  const span = Math.max(world.size.x, world.size.z) / 2 + 4;
  // 그림판 높이는 장면의 가로세로 비율을 따른다(넓게 퍼진 기지 줄에 위아래 빈칸이 크게 남지 않게). cqi = .sm-3d 너비의 1%.
  const ratio = Math.round(((world.size.z + 3) / (world.size.x + 1.5)) * 100);
  return <div className="sm-3d">
    <Probe onRead={setPalette} />
    <p className="sm-3d-hint">끌어서 돌리기 · 휠로 확대 · 오른쪽 버튼(두 손가락)으로 옮기기. 키보드로 고르려면 2D 보기를 쓰세요.
      <button type="button" onClick={() => setResetCount((n) => n + 1)}>시점 되돌리기</button></p>
    {palette && <Canvas className="sm-canvas" style={{ height: `clamp(240px, ${ratio}cqi, 560px)` }} frameloop="demand" shadows flat dpr={[1, 2]} gl={{ alpha: true, antialias: true }}
      camera={{ fov: 35, near: 0.1, far: 400, position: [0, 10, 14] }} aria-label="3D 기지 지도"
      fallback={<p className="st-empty">이 브라우저에서는 3D를 그릴 수 없습니다. 2D 보기를 쓰세요.</p>}>
      <ambientLight intensity={2.1} />
      <directionalLight position={[6, 14, 9]} intensity={1.4} castShadow
        shadow-mapSize={[2048, 2048]} shadow-camera-left={-span} shadow-camera-right={span} shadow-camera-top={span} shadow-camera-bottom={-span}
        shadow-camera-far={80} />
      <group position={[-world.size.x / 2, 0, -world.size.z / 2]}>
        {world.bases.map((w) => <BaseBlock key={w.base.id} world={w} palette={palette} selected={selected} motion={motion} onSelect={onSelect} />)}
        {world.depot && <Depot at={world.depot} count={depot} palette={palette} selected={selected === depotKey} onSelect={() => onSelect(depotKey)} />}
      </group>
      <Rig size={world.size} fitKey={fitKey} />
      <Ticker on={animate} />
    </Canvas>}
  </div>;
}
