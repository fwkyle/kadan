import {storageSnapshot} from './storage.mjs';
import {handleOperationsFlow} from './operations-flow.mjs';
import {DecisionStore} from './decisions.mjs';
import { renderCenterWall, createCenterHandler } from "./center-wall.mjs";
import fs from "node:fs";
import { dutyHead, renderRound } from "./cli.mjs";
import http from "node:http";
import path from "node:path";
import { assessResources } from "./watch.mjs";
import { boardFromRole } from "./board.mjs";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function localTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "모름";
  const pad = n => String(n).padStart(2, "0");
  return `${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function timeTag(value) {
  if (value == null || !Number.isFinite(new Date(value).getTime())) return "모름";
  return `<time title="${escapeHtml(localDateTime(value))}">${localTime(value)}</time>`;
}

function localDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "수집 시각 모름";
  const datePart = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join(". ");
  const timePart = [
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return `${datePart}. ${timePart}`;
}

function roleState(role) {
  if (role.life.state === "alive" && role.life.pidState === "match") {
    return { className: "alive", label: "살아있음" };
  }
  if (role.life.state === "alive") {
    return { className: "changed", label: "PID변경" };
  }
  if (role.life.state === "dead") {
    return { className: "dead", label: "죽음" };
  }
  return { className: "dead", label: role.life.startedAt ? "세션 없음" : "기록없음" };
}

function renderCard(card, collectedAt) {
  const className =
    card.state === "sent" ? "sent" : card.result === "ok" ? "ok" : "failed";
  const label =
    card.state === "sent" ? "보냄(완료 없음)" : `완료 ${card.result}`;
  return `<li class="card ${className}">
    <strong>${escapeHtml(card.taskId)}</strong>
    ${card.title ? `<span class="card-title">${escapeHtml(card.title)}</span>` : ""}
    <span>${escapeHtml(label)}</span>
    ${timeTag(card.at)}
  </li>`;
}

function familyOverlap(board) {
  const workers = [];
  const reviewers = [];
  for (const role of board.roles ?? []) {
    const duty = dutyHead(role.role);
    const family = role.family ?? "모름";
    if (duty === "작업자") workers.push(family);
    if (duty === "검수자") reviewers.push(family);
  }
  if (!workers.length || !reviewers.length) return false;
  const known = [...workers, ...reviewers];
  if (known.some((family) => family === "모름")) return false;
  return new Set(known).size === 1;
}

function renderRoleRow(role, collectedAt, overlap) {
  const state = roleState(role);
  const window = role.window ? escapeHtml(role.window) : "기록없음";
  const activity = role.lastActivityAt
    ? timeTag(role.lastActivityAt)
    : "모름";
  const snapshot = role.waitSnapshot
    ? `<details class="snapshot">
        <summary>${escapeHtml(role.waitSnapshot.fileName)}</summary>
        <pre>${escapeHtml(role.waitSnapshot.tail)}</pre>
      </details>`
    : "";
  const cards =
    role.cards.length > 0
      ? `<ul class="cards">${role.cards
          .map((card) => renderCard(card, collectedAt))
          .join("")}</ul>`
      : '<p class="empty">카드 기록 없음</p>';
  const pending = role.cards.filter((card) => card.state === "sent");
  const pendingSummary =
    pending.length === 0
      ? "-"
      : `${pending.length}장 · ${pending
          .map((card) => escapeHtml(card.taskId))
          .join(", ")}`;
  const harness = escapeHtml(role.harness ?? "모름");
  const model = escapeHtml(role.model ?? "모름");
  const family = escapeHtml(role.family ?? "모름");
  const duty = dutyHead(role.role);
  const warn =
    overlap && (duty === "작업자" || duty === "검수자") && (role.family ?? "모름") !== "모름";
  return `<tr>
    <td class="role-name">${escapeHtml(role.role)}</td>
    <td><span class="dot ${state.className}" aria-hidden="true"></span><span class="state ${state.className}">${state.label}</span>${role.life.startedAt ? ` <span>(start ${timeTag(role.life.startedAt)})</span>` : ""}</td>
    <td>${window}</td>
    <td>${activity}</td>
    <td><details class="role-details">
      <summary>${pendingSummary}</summary>
      ${cards}
      ${snapshot}
    </details></td>
    <td>${harness} · ${model} · ${warn ? `<span class="pill changed">${family}</span>` : family}</td>
  </tr>`;
}

function renderRoleTable(board, collectedAt, ledgerKnown) {
  const overlap = familyOverlap(board);
  const body = ledgerKnown
    ? `<tbody>${board.roles.map((role) => renderRoleRow(role, collectedAt, overlap)).join("")}</tbody>`
    : '<tbody class="role-unknown"><tr><td colspan="6">모름</td></tr></tbody>';
  return `<div class="table-scroll"><table class="role-table">
    <thead><tr>
      <th>역할</th>
      <th>상태</th>
      <th>창</th>
      <th>마지막 활동</th>
      <th>안 끝난 카드</th>
      <th>실행기 · 모델 · 계열</th>
    </tr></thead>
    ${body}
  </table></div>`;
}

// 원장 한 줄은 시각·종류·역할·카드·by만 찍고 끝이었다. 정작 기록해 둔 실행기·모델,
// done의 ok/failed, alert 종류는 화면에 없었다 (2026-09-06 [kyle]: "원장이 이렇게 부실한가").
// 원장에 있는 값만 옮긴다. 없는 값은 만들지 않는다.
// 옛 카드 30장이 한 칸에 쀰아져 화면을 먹었다 (2026-09-06 [kyle]). 앞에서 6개만 보이고
// 나머지는 수로 접는다. 전체는 판 탭과 원장에 그대로 남아 있다.
const ROUND_CELL_LIMIT = 6;

export function boardLabel(name) {
  return name === "(없음)" ? "판 없이 만든 옛 카드" : name;
}

function roundCell(board) {
  const rounds = board.rounds ?? [];
  if (rounds.length === 0) return "-";
  const shown = rounds.slice(0, ROUND_CELL_LIMIT).map(item => {
    const title = board.titleById?.[item.family];
    return `${escapeHtml(item.family)}${title ? `(${escapeHtml(title)})` : ""} 라운드 ${item.latestRound}/18`;
  }).join(", ");
  const hidden = rounds.length - ROUND_CELL_LIMIT;
  return hidden > 0 ? `${shown} <span class="about">외 ${hidden}장</span>` : shown;
}

// 사람이 대시보드에서 확인해야 하는 것: 지금 어떻게 되고 있나, 무엇이 끝났고 무엇이 남았나
// (2026-09-06 [kyle]). 원장의 plan/send/done을 한 표로 눕힌다.
// 판마다 어디까지 왔는지 한눈에 — 과거·진행·멈춤·미래를 세고 막대로 그린다 (2026-09-06 [kyle]).
// [kyle] 2026-09-06: "판에 카드 줄세우고, 티키타카 있으면 그 아래, 그 위에 감독, 그 위에 슈퍼감독".
// 줄글 나열 대신 계층으로 접는다. 직무는 판 접두사를 뗀 첫 조각으로 가른다(잠긴 규칙 8과 같은 방식).
function cardState(card, role) {
  if (card.state === "done") return `완료 ${card.result ?? ""}`.trim();
  return role.life?.state === "alive" ? "진행" : "멈춤";
}

function cardPill(card, role) {
  if (card.state === "done") return card.result === "ok" ? "alive" : "failed";
  return role.life?.state === "alive" ? "changed" : "failed";
}

function shortStamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function dutyRank(role, board) {
  const head = String(role ?? "").replace(board && role?.startsWith(`${board}-`) ? `${board}-` : "", "").split("-")[0];
  if (head.includes("슈퍼")) return 0;
  if (head.includes("감독")) return 1;
  if (head.includes("검수")) return 2;
  return 3;
}

// 카드 한 장의 왕복(티키타카)을 시각 순으로 모은다. send가 여러 번이면 그게 왕복이다.
export function cardHistory(entries = []) {
  const history = new Map();
  for (const entry of entries) {
    if (!entry || !entry.taskId || !entry.role) continue;
    if (entry.kind !== "send" && entry.kind !== "done") continue;
    const key = `${entry.role}\u0000${entry.taskId}`;
    if (!history.has(key)) history.set(key, []);
    history.get(key).push({ kind: entry.kind, at: entry.t, by: entry.by ?? "모름", result: entry.result ?? null, preview: entry.preview ?? null });
  }
  for (const list of history.values()) list.sort((a, b) => new Date(a.at ?? 0) - new Date(b.at ?? 0));
  return history;
}

export function boardProgress(board) {
  const cards = (board.roles ?? []).flatMap(role => (role.cards ?? []).map(card => ({ card, role })));
  const done = cards.filter(({ card }) => card.state === "done").length;
  const running = cards.filter(({ card, role }) => card.state === "sent" && role.life?.state === "alive").length;
  const stuck = cards.filter(({ card, role }) => card.state === "sent" && role.life?.state !== "alive").length;
  const planned = (board.plannedCards ?? []).length;
  const total = done + running + stuck + planned;
  const share = value => (total === 0 ? 0 : Math.round((value / total) * 100));
  return { done, running, stuck, planned, total, percent: share(done), shares: { done: share(done), running: share(running), stuck: share(stuck), planned: share(planned) } };
}

export function cardFlow(tree = [], entries = []) {
  const previews = new Map();
  for (const entry of entries) {
    if (entry?.kind === "send" && entry.taskId && entry.preview) previews.set(entry.taskId, entry.preview);
  }
  const rows = [];
  for (const board of tree) {
    for (const card of board.plannedCards ?? []) {
      rows.push({ state: "미래", board: board.name, taskId: card.taskId, title: card.title ?? null, role: null, at: card.plannedAt ?? null, preview: null });
    }
    for (const role of board.roles ?? []) {
      for (const card of role.cards ?? []) {
        rows.push({
          // 보냈는데 done이 없고 그 역할 세션도 없으면 멈춤(미아)이다. 임의 시간 기준을 쓰지 않는다
          // — 2026-09-01 미아 6건이 정확히 이 모양이었다 (2026-09-06 [kyle]).
          state: card.state === "done" ? "과거" : role.life?.state === "alive" ? "진행" : "멈춤",
          result: card.result ?? null,
          board: board.name,
          taskId: card.taskId,
          title: card.title ?? null,
          role: role.role,
          at: card.at ?? null,
          preview: previews.get(card.taskId) ?? null,
        });
      }
    }
  }
  const order = { 진행: 0, 미래: 1, 멈춤: 2, 과거: 3 };
  return rows.sort((a, b) => order[a.state] - order[b.state] || new Date(b.at ?? 0) - new Date(a.at ?? 0));
}

export function ledgerDetail(entry) {
  if (!entry) return "";
  const parts = [];
  if (entry.kind === "start") {
    if (entry.harness) parts.push(entry.harness);
    if (entry.model) parts.push(entry.model);
    if (entry.window) parts.push(`창 ${entry.window}`);
  } else if (entry.kind === "send") {
    if (entry.title) parts.push(entry.title);
    if (entry.bytes != null) parts.push(`${entry.bytes}B`);
  } else if (entry.kind === "done") {
    if (entry.result) parts.push(entry.result);
  } else if (entry.kind === "plan") {
    if (entry.title) parts.push(entry.title);
    if (entry.about) parts.push(entry.about);
  } else if (entry.kind === "alert") {
    if (entry.alertKind) parts.push(entry.alertKind);
    if (entry.level) parts.push(entry.level);
    if (entry.recipient) parts.push(`→ ${entry.recipient}`);
    if (entry.delivered === false) parts.push("전달 실패");
  }
  return parts.join(" · ");
}

function renderMailbox(mailbox, collectedAt, ledgerKnown, caption = "우편함 · 최근 20건") {
  let body;
  if (!ledgerKnown || mailbox === null) {
    body = '<tbody class="mailbox-unknown"><tr><td colspan="5">모름</td></tr></tbody>';
  } else if (mailbox.length === 0) {
    body = '<tbody><tr><td colspan="5">편지 없음</td></tr></tbody>';
  } else {
    body = `<tbody>${mailbox
      .map(
        (item) => `<tr>
      <td>${timeTag(item.at)}</td>
      <td>${escapeHtml(item.by ?? "모름")}</td>
      <td>${escapeHtml(item.role ?? "모름")}</td>
      <td>${escapeHtml(item.taskId ?? "-")}${item.title ? `<div class="about">${escapeHtml(item.title)}</div>` : ""}${item.preview ? `<div class="about">${escapeHtml(item.preview)}</div>` : ""}${item.body ? `<details class="mail-body"><summary>본문 보기</summary><pre>${escapeHtml(item.body)}</pre></details>` : ""}</td>
      <td>${escapeHtml(item.bytes == null ? "모름" : `${item.bytes}바이트`)}</td>
    </tr>`
      )
      .join("")}</tbody>`;
  }
  return `<div class="table-scroll"><table class="mailbox-table">
    <caption>${escapeHtml(caption)}</caption>
    <thead><tr>
      <th>시각</th>
      <th>보낸이</th>
      <th>받는이</th>
      <th>카드</th>
      <th>크기</th>
    </tr></thead>
    ${body}
  </table></div>`;
}

export function buildWallSnapshot({ collect }) {
  try {
    return { resources: collect(), resourceError: null };
  } catch (error) {
    return { resources: null, resourceError: error.message };
  }
}

function renderResources(resources, resourceError, judge, all, toggleHref) {
  const number = (value, digits, suffix = "") =>
    value == null ? "모름" : value.toFixed(digits) + suffix;
  let text = resourceError ? `자원 모름 (${resourceError})` : "자원 모름";
  let verdict = "모름";
  if (resources) {
    const { current, ncpu } = resources;
    const memory = current.memory === "unknown" || current.memory == null ? "모름" : current.memory;
    text = `자원 · 메모리 여유 ${number(current.freePercent, 0, "%")} (${memory}) · 스왑 ${number(current.swapUsed, 2, "MB")} · CPU 5분 ${number(current.load5, 2)}/${ncpu ?? "모름"}`;
    if (judge) {
      const alert = assessResources(null, current, ncpu).alerts[0];
      verdict = alert
        ? `${alert.level} (${alert.signals.join(", ")}) — 현재 작업과 함께 감독이 판단`
        : "GREEN";
    }
  }
  const href = toggleHref ?? (judge ? (all ? "?all=1" : "?") : `?judge=1${all ? "&all=1" : ""}`);
  return `<section class="resources">
        <p>${escapeHtml(text)}</p>
        ${judge ? `<p class="resource-judgement">카단 판정 ${escapeHtml(verdict)} <small>(현재 수치 참고용 · 자동 중단·알림 없음)</small></p>` : ""}
        <a href="${escapeHtml(href)}">카단 판정 ${judge ? "끄기" : "켜기"}</a>
      </section>`;
}

export function renderWallHtml({ tree, mailbox = [], entries = [], collectedAt, ledgerPath, ledgerLines, error, all = false, resources = null, resourceError = null, judge = false, refresh = 10, mailBoard = '', hideWatch = false, kind = '', watchPid = null, version = '', cardFiles = {} }) {
  const known = ledgerLines !== null;
  const activityOf = board => Math.max(Date.parse(board.plannedAt) || -Infinity, ...(board.roles ?? []).map(role => Date.parse(role.lastActivityAt) || -Infinity));
  // "도는 판"은 살아있는 역할이 있는 판만이다. 24시간 안에 활동만 있으면 도는 판으로 세던 옛 기준은
  // 끝난 판·한 번 쓴 판·미아 판을 한 덩어리로 만들어 10개라는 뜻 없는 숫자를 냈다 (2026-09-06 [kyle]).
  const byActivity = (a,b) => activityOf(b)-activityOf(a);
  const isLive = board => (board.roles ?? []).some(role => role.life?.state === 'alive');
  const liveTree = tree.filter(isLive).sort(byActivity);
  const recentTree = tree.filter(board => !isLive(board) && new Date(collectedAt).getTime() - activityOf(board) <= 86400000).sort(byActivity);
  const currentTree = [...liveTree, ...recentTree];
  const visibleTree = known ? (all ? [...tree].sort((a,b)=>activityOf(b)-activityOf(a)) : currentTree) : [];
  const roles = currentTree.flatMap(board=>board.roles);
  const alive = roles.filter(role=>role.life.state==='alive').length;
  const missing = roles.filter(role=>role.life.state==='unknown' && role.life.startedAt).length;
  const pending = board => board.roles.flatMap(role=>role.cards).filter(card=>card.state==='sent').length;
  const planned = board => board.plannedCards?.length ?? 0;
  const supervisors = roles.filter(role=>role.life.state==='alive' && (role.role.slice((boardFromRole(role.role)?.length ?? -1)+1).split('-')[0].includes('감독'))).length;
  const count = n => known ? n : '모름';
  const query = changes => {
    const values = {judge:judge?'1':'',all:all?'1':'',refresh:refresh===10?'':String(refresh),board:mailBoard,hideWatch:hideWatch?'1':'',kind,...changes};
    const params = new URLSearchParams();
    for(const [key,value] of Object.entries(values)) if(value !== '') params.set(key,value);
    return '?' + params.toString();
  };
  const hidden = except => Object.entries({judge:judge?'1':'',all:all?'1':'',refresh:refresh===10?'':String(refresh),board:mailBoard,hideWatch:hideWatch?'1':'',kind}).filter(([key,value])=>value!=='' && !except.includes(key)).map(([key,value])=>`<input type="hidden" name="${key}" value="${escapeHtml(value)}">`).join('');
  const options = (values,selected) => values.map(([value,label])=>`<option value="${escapeHtml(value)}"${value===selected?' selected':''}>${escapeHtml(label)}</option>`).join('');
  const allMail = !known ? [] : entries.length ? entries.filter(item=>item.kind==='send').reverse().map(item=>({...item,at:item.t})) : (mailbox ?? []);
  const mailFor = board => allMail.filter(item=>boardFromRole(item.role)===board).slice(0,10);
  const pills = board => board.roles.map(role=>`<span class="pill ${roleState(role).className}">${escapeHtml(role.role)} ${roleState(role).label}</span>`).join(' ') || '-';
  const summary = known ? `살아있는 역할 ${alive}개 · 도는 판 ${currentTree.length}개 · 안 끝난 카드 ${currentTree.reduce((n,b)=>n+pending(b),0)}장 · 발령 전 ${currentTree.reduce((n,b)=>n+planned(b),0)}장` : '살아있는 역할 모름 · 도는 판 모름 · 안 끝난 카드 모름 · 발령 전 모름';
  const status = !known || !resources ? '모름' : missing || (judge && assessResources(null,resources.current,resources.ncpu).alerts.length) ? '주의' : '정상';
  const stats = [['상태',status],['살아있는 역할',count(alive)],['도는 판',count(liveTree.length)],['안 끝난 카드',count(currentTree.reduce((n,b)=>n+pending(b),0))],['발령 전',count(currentTree.reduce((n,b)=>n+planned(b),0))],['멈춤 카드',count(liveTree.concat(recentTree).reduce((n,b)=>n+boardProgress(b).stuck,0))],['세션 없음',count(missing)]];
  const alerts = entries.filter(item=>item.kind==='alert').slice(-10).reverse();
  const alertPanel = `<section class="panel" id="recent-alerts"><h3>최근 알림</h3>${!known ? '<p>모름</p>' : !alerts.length ? '<p>알림 없음</p>' : `<div class="table-scroll"><table><thead><tr><th>시각</th><th>종류</th><th>대상</th><th>수신자</th><th>전달</th></tr></thead><tbody>${alerts.map(item=>`<tr data-alert="${escapeHtml(item.alertKind)}"><td>${timeTag(item.t)}</td><td>${escapeHtml(item.alertKind)}${item.resolved?' · 해소':''}</td><td>${escapeHtml(item.role ?? item.session ?? '-')}</td><td>${escapeHtml(item.recipient ?? '-')}</td><td><span class="pill ${item.delivered?'alive':'changed'}">${item.delivered?'전달됨':'실패'}</span></td></tr>`).join('')}</tbody></table></div>`}</section>`;
  const boardPanel = board => {
    const boardRoles = board.roles.map(role=>{
      const latest = entries.filter(entry=>entry.role===role.role && ['start','stop'].includes(entry.kind)).at(-1);
      if (latest?.kind!=='stop' || typeof latest.rottieWindowClosed!=='boolean') return role;
      const window = !latest.rottieWindowClosed ? '열림' : latest.rottieWindowRemoved===true ? '제거됨' : latest.rottieWindowRemoved===false ? '닫힘·탭 남음' : '닫힘';
      return {...role,window:`rottie ${window}`};
    });
    return `<section class="board panel" data-board-panel="${escapeHtml(board.name)}"><h2>판 ${escapeHtml(board.name)}${board.about?` <small class="about">${escapeHtml(board.about)}</small>`:''}</h2><div>${pills(board)}</div><p>마지막 활동 ${timeTag(activityOf(board))}</p>${planned(board)?`<p>발령 전 ${planned(board)}장: ${board.plannedCards.map(card=>escapeHtml(card.title?`${card.taskId}(${card.title})`:card.taskId)).join(', ')}</p>`:''}${(board.rounds??[]).map(group=>`<p>${escapeHtml(renderRound(group))}</p>`).join('')}${renderRoleTable({...board,roles:boardRoles},collectedAt,true)}<h3>이 판 우편</h3>${renderMailbox(mailFor(board.name),collectedAt,true,'최근 10건')}</section><!-- end board -->`;
  };
  const ledgerTail = entries.filter(item=>!kind || item.kind===kind).slice(-50).reverse();
  const flow = known ? cardFlow(visibleTree, entries) : [];
  const history = cardHistory(entries);
  const nav = [['dashboard','대시보드',''],['boards','판',count(visibleTree.length)],['cards','카드',count(flow.filter(row=>row.state!=='과거').length)],['mailbox','우편함',count(Math.min(allMail.length,20))],['ledger','원장',count(ledgerLines)],['settings','설정','']];
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>카단 관제 화면</title>
<style>
:root { font-family:-apple-system,system-ui,"Apple SD Gothic Neo",sans-serif; color:#0d0d0d; background:#fff; font-size:14px; line-height:1.5; }
* { box-sizing:border-box; } body { margin:0; } a { color:inherit; text-decoration:none; } a:hover { text-decoration:underline; } :focus-visible { outline:2px solid #0a7d5c; outline-offset:3px; }
.shell { display:flex; min-height:100vh; } .rail { width:230px; flex:none; position:sticky; top:0; height:100vh; background:#f9f9f9; border-right:1px solid #e6e6e6; padding:18px 14px; display:flex; flex-direction:column; overflow:auto; }
.brand { font-weight:700; font-size:16px; display:flex; gap:8px; align-items:center; padding:4px 8px 18px; } .logo { width:22px; height:22px; background:#0d0d0d; border-radius:50%; flex:none; } .ver { font-size:11px; font-weight:400; color:#6e6e6e; margin-left:auto; }
.nav { display:flex; align-items:center; gap:8px; padding:9px 12px; border-radius:8px; } .nav.active { background:#eee; font-weight:600; } .badge,.pill { display:inline-block; border-radius:999px; padding:1px 8px; font-size:12px; background:#f4f4f4; } .badge { margin-left:auto; } .navsec { color:#6e6e6e; font-size:11px; margin:18px 12px 6px; } .rail-foot { margin-top:auto; border-top:1px solid #e6e6e6; padding-top:12px; font-size:12px; color:#6e6e6e; overflow-wrap:anywhere; }
main { flex:1; min-width:0; padding:30px 40px 60px; max-width:1480px; } h2 { margin:0 0 12px; font-size:22px; } h3 { margin:0 0 8px; font-size:15px; } p { margin:8px 0; } .sub,.empty,.empty-page { color:#6e6e6e; } .tabs { display:flex; gap:20px; overflow-x:auto; border-bottom:1px solid #e6e6e6; margin:18px 0; padding-bottom:10px; } .tabs a { white-space:nowrap; } .tabs .active { font-weight:700; border-bottom:2px solid; }
.stat-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; margin:14px 0; } .stat { border:1px solid #e6e6e6; border-radius:12px; padding:14px 16px; } .k { font-size:12px; color:#6e6e6e; } .v { font-size:22px; font-weight:700; } .banner { background:#f4f4f4; padding:9px 14px; border-radius:8px; margin-bottom:14px; } .panel { border:1px solid #e6e6e6; border-radius:12px; padding:16px 18px; margin-bottom:14px; min-width:0; } .two { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.3fr); gap:14px; } .resources a { text-decoration:underline; } .resources { overflow-wrap:anywhere; }
.table-scroll { overflow-x:auto; max-width:100%; } table { width:100%; border-collapse:collapse; font-size:13px; } th,td { text-align:left; padding:8px 10px; border-top:1px solid #eee; vertical-align:top; } th { font-size:12px; font-weight:500; color:#6e6e6e; white-space:nowrap; } caption { text-align:left; color:#6e6e6e; font-size:12px; padding:6px 0; } time { white-space:nowrap; font:12px ui-monospace,monospace; } .role-table { min-width:650px; } .role-name { font-weight:700; } .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:currentColor; margin-right:6px; } .alive { color:#0a7d5c; } .dead { color:#6e6e6e; } .changed { color:#9a4a08; } .pill.alive { background:#e7f5ef; } .pill.changed { background:#fff2df; } .state { white-space:nowrap; }
.cards { list-style:none; padding:0; } .card { display:flex; gap:8px; flex-wrap:wrap; padding:6px; } .card-title { color:#0d0d0d; } .about { font-weight:400; font-size:12px; color:#6e6e6e; display:block; margin-top:2px; }
/* 자원은 한 줄이다. 그것만큼만 차지하고 남는 포은 판 요약에 준다 (2026-09-06 [kyle]: 빈칸이 반을 먹고 요약은 안 보였다). */
.resource-strip { padding:12px 18px; } .resource-strip h3 { display:inline; margin-right:10px; } .resource-strip .resources { display:inline; }
#board-summary td:first-child { min-width:170px; } #board-summary td:nth-child(2) { min-width:150px; }
/* 원장은 줄 나열이 아니라 표다 — 열이 맞아야 눈으로 훑는다 (2026-09-06 [kyle]). */
.node { border-left:2px solid #eee; margin:4px 0 4px 6px; padding-left:10px; } .node > summary { cursor:pointer; padding:3px 0; } .board-node > summary { font-size:15px; } .round-list { list-style:none; margin:2px 0 6px; padding-left:12px; } .round-list li { padding:2px 0; }
.board-progress { padding:10px 0; border-bottom:1px solid #f0f0f0; } .board-progress:last-child { border-bottom:0; } .bp-head { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
.bar { display:flex; height:10px; border-radius:999px; overflow:hidden; background:#f0f0f0; margin:6px 0; } .seg { display:block; } .seg.done { background:#0a7d5c; } .seg.running { background:#e08a2e; } .seg.stuck { background:#b91c1c; } .seg.planned { background:#d4d4d4; }
.pill.failed { background:#fde8e8; color:#b91c1c; } .card-flow td { vertical-align:top; } .card-flow td.detail { color:#6e6e6e; max-width:560px; } .card-body pre { max-height:420px; overflow:auto; font-size:12px; } .card-body summary { color:#0d0d0d; }
.ledger-table td { white-space:nowrap; } .ledger-table td.detail { white-space:normal; color:#6e6e6e; } .card.failed,.collection-error { color:#b91c1c; } .card.sent { color:#9a4a08; } details summary { cursor:pointer; } pre { white-space:pre-wrap; overflow-wrap:anywhere; background:#f4f4f4; padding:12px; border-radius:8px; } .toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:12px; } select,button { font:inherit; background:#fff; border:1px solid #ddd; border-radius:999px; padding:4px 10px; } .page { display:none; scroll-margin-top:30px; } .page.on { display:block; } [hidden] { display:none!important; } .summary { font-size:12px; color:#6e6e6e; }
@media(max-width:1100px) { .two { grid-template-columns:minmax(0,1fr); } }
@media(max-width:759px) { .page { scroll-margin-top:180px; } .shell { display:block; } .rail { width:auto; height:auto; position:static; border-right:0; border-bottom:1px solid #e6e6e6; padding:12px; } .brand { padding-bottom:8px; } .rail nav { display:flex; overflow-x:auto; } .nav { flex:none; padding:8px; font-size:13px; } .rail .navsec,.live-boards,.rail-foot { display:none; } main { padding:18px 16px; } .panel { padding:14px 12px; } .stat-row { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style></head><body><div class="shell">
<aside class="rail" aria-label="사이드 GNB"><div class="brand"><span class="logo"></span>카단 관제 ${version?`<span class="ver">v${escapeHtml(version)}</span>`:''}</div><nav>${nav.map(([id,label,badge])=>`<a class="nav${id==='dashboard'?' active':''}" href="#${id}" data-page="${id}">${label}${badge!==''?`<span class="badge">${badge}</span>`:''}</a>`).join('')}</nav><div class="navsec">살아있는 판</div><div class="live-boards">${known?currentTree.map(board=>`<a class="nav" href="#boards" data-board="${escapeHtml(board.name)}"><span class="dot ${board.roles.some(r=>r.life.state==='alive')?'alive':'dead'}"></span>${escapeHtml(board.name)}<span class="badge">발령 전 ${planned(board)} / 세션 없음 ${board.roles.filter(r=>r.life.startedAt && r.life.state==='unknown').length}</span></a>`).join(''):'모름'}</div><footer class="rail-foot"><p>수집 시각(로컬) <span title="${escapeHtml(localDateTime(collectedAt))}">${new Date(collectedAt).toTimeString().slice(0,8)}</span></p>${watchPid?`<p>watch PID ${escapeHtml(watchPid)}</p>`:''}<p>${escapeHtml(ledgerPath ?? '모름')}</p></footer></aside>
<main><section class="page on" id="dashboard"><h2>대시보드</h2><p class="sub">판·카드·자원을 읽는다.</p><div class="tabs"><a class="active" href="#dashboard">개요</a><a href="#boards">살아있는 판</a><a href="#ledger">원장</a></div><div class="stat-row">${stats.map(([label,value])=>`<div class="stat"><div class="k">${label}</div><div class="v">${value}</div></div>`).join('')}</div><p class="summary">${summary}</p><div class="banner">실제 원장 ${count(ledgerLines)}줄 · 감독 ${count(supervisors)} · ${watchPid?'watch 실행 중':'watch 모름 → kadan watch 켜기 안내'}</div>${error?`<p class="collection-error">${escapeHtml(error)}</p>`:''}<div class="panel resource-strip"><h3>자원</h3>${renderResources(resources,resourceError,judge,all,query({judge:judge?'':'1'}))}</div><div class="panel"><h3>판 진행</h3>${!known?'<p>모름</p>':liveTree.length===0?'<p class="about">살아있는 역할이 있는 판이 없다</p>':liveTree.map(board=>`<div class="board-progress"><div class="bp-head"><strong>${escapeHtml(boardLabel(board.name))}</strong>${board.about?`<span class="about">${escapeHtml(board.about)}</span>`:''}<span class="about">${(board.roles??[]).filter(r=>r.life?.state==='alive').map(r=>escapeHtml(r.role)).join(' · ')}</span></div><div class="bar" title="${boardProgress(board).percent}% 끝남"><span class="seg done" style="width:${boardProgress(board).shares.done}%"></span><span class="seg running" style="width:${boardProgress(board).shares.running}%"></span><span class="seg stuck" style="width:${boardProgress(board).shares.stuck}%"></span><span class="seg planned" style="width:${boardProgress(board).shares.planned}%"></span></div><p class="about">끝남 ${boardProgress(board).done}장 · 진행 ${boardProgress(board).running}장 · 멈춤 ${boardProgress(board).stuck}장 · 앞으로 ${boardProgress(board).planned}장</p></div>`).join('')}</div><div class="panel"><h3>판 한 줄 요약</h3>${known?`<div class="table-scroll"><table id="board-summary"><thead><tr><th>판</th><th>역할</th><th>안 끝난</th><th>발령 전</th><th>라운드</th><th>마지막 활동</th></tr></thead><tbody>${visibleTree.map(board=>`<tr><td><a href="#boards" data-board="${escapeHtml(board.name)}">${escapeHtml(boardLabel(board.name))}</a>${board.about?`<div class="about">${escapeHtml(board.about)}</div>`:''}</td><td>${pills(board)}</td><td>${pending(board)}</td><td>${planned(board)}</td><td>${roundCell(board)}</td><td>${timeTag(activityOf(board))}</td></tr>`).join('')}</tbody></table></div>`:'<p>모름</p>'}</div><div class="panel"><h3>최근 우편 5건</h3>${renderMailbox(allMail.slice(0,5),collectedAt,known,'최근 5건')}</div>${alertPanel}</section><!-- end screen -->
<section class="page" id="boards"><h2>판</h2><div class="panel"><h3>판 나무</h3><p class="about">슈퍼감독 · 감독 · 작업자 · 검수자 순으로 접힌다. 카드를 열면 티키타카 왕복이 나온다.</p>${!known?'<p>모름</p>':currentTree.length===0?'<p class="about">지금 도는 판 없음</p>':currentTree.map(board=>`<details class="node board-node"${(board.roles??[]).some(r=>r.life?.state==='alive')?' open':''}><summary><strong>${escapeHtml(boardLabel(board.name))}</strong>${board.about?` <span class="about">${escapeHtml(board.about)}</span>`:''} <span class="about">끝남 ${boardProgress(board).done} · 진행 ${boardProgress(board).running} · 멈춤 ${boardProgress(board).stuck} · 앞으로 ${boardProgress(board).planned}</span></summary>${[...(board.roles??[])].sort((a,b)=>dutyRank(a.role,board.name)-dutyRank(b.role,board.name)||(a.role<b.role?-1:1)).map(role=>`<details class="node role-node"${role.life.state==='alive'?' open':''}><summary><span class="dot ${role.life.state==='alive'?'alive':'dead'}"></span><strong>${escapeHtml(role.role)}</strong> <span class="about">${escapeHtml([role.harness,role.model].filter(Boolean).join(' · ')||'실행기 모름')} · ${escapeHtml(role.life.state==='alive'?'살아있음':'세션 없음')}</span></summary>${(role.cards??[]).length?(role.cards??[]).map(card=>`<details class="node card-node"${cardState(card,role)==='진행'?' open':''}><summary><span class="pill ${cardPill(card,role)}">${escapeHtml(cardState(card,role))}</span> ${escapeHtml(card.taskId)}${card.title?` <span class="about">${escapeHtml(card.title)}</span>`:''} <span class="about">${card.at?shortStamp(card.at):''}</span></summary><ol class="round-list">${(history.get(role.role+'\u0000'+card.taskId)??[]).map((step,index)=>`<li><span class="pill">${escapeHtml(step.kind==='send'?'왕복 '+(index+1):'완료 '+(step.result??''))}</span> ${timeTag(step.at)} <span class="about">${escapeHtml(step.by)}</span>${step.preview?`<div class="about">${escapeHtml(step.preview)}</div>`:''}</li>`).join('')||'<li class="about">왕복 기록 없음</li>'}</ol></details>`).join(''):'<p class="about">카드 없음</p>'}</details>`).join('')}${(board.plannedCards??[]).length?`<p class="about">앞으로 할 카드: ${(board.plannedCards??[]).map(c=>escapeHtml(c.title?c.taskId+'('+c.title+')':c.taskId)).join(', ')}</p>`:''}</details>`).join('')}</div><div class="tabs">${visibleTree.map(board=>`<a href="#boards" data-board="${escapeHtml(board.name)}">${escapeHtml(board.name)}</a>`).join('')}<a href="${escapeHtml(query({all:'1'}))}#boards">지난 판 ▾</a></div>${!known?`<section class="board"><h2>판 모름</h2>${renderRoleTable({roles:[]},collectedAt,false)}<h3>이 판 우편</h3>${renderMailbox(null,collectedAt,false)}</section>`:visibleTree.map(boardPanel).join('')||'<p class="empty-page">표시할 판 기록 없음</p>'}</section><!-- end screen -->
<section class="page" id="cards"><h2>카드</h2><p class="sub">지금 도는 것 · 앞으로 할 것 · 끝난 것</p>${!known?'<p>모름</p>':`<div class="panel"><div class="table-scroll"><table class="card-flow"><thead><tr><th>상태</th><th>판</th><th>카드</th><th>담당</th><th>시각</th><th>무엇을 보냈나</th></tr></thead><tbody>${flow.map(row=>`<tr data-state="${escapeHtml(row.state)}"><td><span class="pill ${row.state==='진행'?'changed':row.state==='과거'?(row.result==='ok'?'alive':'failed'):''}">${escapeHtml(row.state)}${row.state==='과거'&&row.result?` ${escapeHtml(row.result)}`:''}</span></td><td>${escapeHtml(boardLabel(row.board))}</td><td>${escapeHtml(row.taskId)}${row.title?`<div class="about">${escapeHtml(row.title)}</div>`:''}</td><td>${escapeHtml(row.role ?? '-')}</td><td>${row.at?timeTag(row.at):'-'}</td><td class="detail">${escapeHtml(row.preview ?? '-')}${cardFiles[row.taskId]?.text?`<details class="card-body"><summary>카드 본문 보기</summary><p class="about">${escapeHtml(cardFiles[row.taskId].path)}</p><pre>${escapeHtml(cardFiles[row.taskId].text)}</pre></details>`:''}${cardFiles[row.taskId]?.error?`<p class="about">카드 파일 ${escapeHtml(cardFiles[row.taskId].error)}: ${escapeHtml(cardFiles[row.taskId].path)}</p>`:''}</td></tr>`).join('')||'<tr><td colspan="6">카드 기록 없음</td></tr>'}</tbody></table></div></div>`}</section><!-- end screen -->
<section class="page" id="mailbox"><h2>우편함</h2><div class="panel"><form class="toolbar" method="get" action="#mailbox">${hidden(['board','hideWatch'])}<label>판 <select name="board">${options([['','모든 판'],...Array.from(new Set(allMail.map(item=>boardFromRole(item.role)).filter(Boolean))).sort().map(name=>[name,name])],mailBoard)}</select></label><label><input type="checkbox" name="hideWatch" value="1"${hideWatch?' checked':''}>watch 숨기기</label><button>적용</button></form>${renderMailbox(allMail.filter(item=>(!mailBoard || boardFromRole(item.role)===mailBoard)&&(!hideWatch || item.by!=='watch')).slice(0,20),collectedAt,known)}</div></section><!-- end screen -->
<section class="page" id="ledger"><h2>원장</h2><p>${escapeHtml(ledgerPath ?? '모름')} · ${count(ledgerLines)}줄</p><div class="panel"><h3>최근 50줄</h3><form class="toolbar" method="get" action="#ledger">${hidden(['kind'])}<label>종류 <select name="kind">${options([['','모든 종류'],...['plan','start','send','done','stop','alert'].map(k=>[k,k])],kind)}</select></label><button>적용</button></form>${!known?'<p>모름</p>':`<div class="table-scroll"><table class="ledger-table"><thead><tr><th>시각</th><th>종류</th><th>대상</th><th>카드</th><th>누가</th><th>상세</th></tr></thead><tbody>${ledgerTail.map(item=>`<tr data-kind="${escapeHtml(item.kind)}"><td>${timeTag(item.t)}</td><td><span class="pill">${escapeHtml(item.kind)}</span></td><td>${escapeHtml(item.role ?? item.board ?? item.session ?? '-')}</td><td>${escapeHtml(item.taskId ?? '-')}</td><td>${escapeHtml(item.by ?? '모름')}</td><td class="detail">${escapeHtml(ledgerDetail(item)) || '-'}</td></tr>`).join('')||'<tr><td colspan="6">기록 없음</td></tr>'}</tbody></table></div><details><summary>원문 JSON 보기</summary><pre>${escapeHtml(ledgerTail.map(item=>JSON.stringify(item)).join('\n'))}</pre></details>`}</div></section><!-- end screen -->
<section class="page" id="settings"><h2>설정</h2><p class="sub">전부 주소 파라미터. 쿠키·저장 없음.</p><div class="panel"><h3>카단 판정 표시</h3><a href="${escapeHtml(query({judge:judge?'':'1'}))}#settings">카단 판정 ${judge?'끄기':'켜기'}</a></div><div class="panel"><h3>지난 판도 보기</h3><a href="${escapeHtml(query({all:all?'':'1'}))}#settings">전체 판 ${all?'끄기':'켜기'}</a></div><div class="panel"><h3>새로고침</h3><form method="get" action="#settings">${hidden(['refresh'])}<label>주기 <select name="refresh">${options([['10','10초'],['30','30초'],['0','끔']],String(refresh))}</select></label> <button>적용</button></form></div></section><!-- end screen -->
</main></div><script>
function showPage(){const id=location.hash.slice(1);const page=['dashboard','boards','cards','mailbox','ledger','settings'].includes(id)?id:'dashboard';document.querySelectorAll('.page').forEach(el=>el.classList.toggle('on',el.id===page));document.querySelectorAll('[data-page]').forEach(el=>el.classList.toggle('active',el.dataset.page===page));}
function showBoard(name){document.querySelectorAll('[data-board-panel]').forEach(el=>el.hidden=el.dataset.boardPanel!==name);document.querySelectorAll('[data-board]').forEach(el=>el.classList.toggle('active',el.dataset.board===name));}
document.querySelectorAll('[data-board]').forEach(el=>el.addEventListener('click',()=>showBoard(el.dataset.board)));const first=document.querySelector('[data-board-panel]');if(first)showBoard(first.dataset.boardPanel);addEventListener('hashchange',showPage);showPage();
// 자동 새로고침은 meta refresh가 아니라 location.reload()다. meta는 주소의 #탭을 버려서
// 새로고침마다 개요로 돌아갔다 (2026-09-06 [kyle] 신고). reload는 보던 탭을 그대로 둔다.
${refresh===0?'':`setTimeout(()=>location.reload(),${refresh*1000});`}
</script></body></html>`;
}

export function createWallServer(loadSnapshot, {home,notify} = {}) {
  const centerHandler=home?createCenterHandler(home,{notify}):null;
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (centerHandler && !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(request.headers.host??"")) { response.writeHead(403); response.end("local host required"); return; }
    if (home && handleOperationsFlow(home,request,response,url)) return;
    if (centerHandler && await centerHandler.handle(request,response,url)) return;
    const serve=()=>{
    const snapshot=loadSnapshot();
    if(centerHandler) {
      snapshot.home=home;
      try{snapshot.decisions=new DecisionStore(home).list()}catch(error){snapshot.decisionError=error.message;snapshot.decisions=[]}
    }
    if (url.pathname === '/api/cards') {
      response.writeHead(snapshot.centerError?503:200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      response.end(JSON.stringify({center:snapshot.center,error:snapshot.centerError})); return;
    }
    if (centerHandler && url.searchParams.get('legacy')!=='1') {
      const html=renderCenterWall(snapshot,{token:centerHandler.token,url});
      response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(html);return;
    }
    let html = renderWallHtml({
      ...snapshot,
      all: url.searchParams.get("all") === "1",
      judge: url.searchParams.get("judge") === "1",
      refresh: ["0", "30"].includes(url.searchParams.get("refresh")) ? Number(url.searchParams.get("refresh")) : 10,
      mailBoard: url.searchParams.get("board") ?? "",
      hideWatch: url.searchParams.get("hideWatch") === "1",
      kind: url.searchParams.get("kind") ?? "",
    });
    if(url.searchParams.get("legacy")=== "1") html=html.replace("<body>",'<body><div style="padding:16px;background:#fff0d0">참고용 옛 화면: 진행률은 현재 중앙 상태와 다를 수 있습니다. <a href="/">새 화면으로 돌아가기</a></div>');
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(html);
    };
    try{if(home)storageSnapshot(home,serve);else serve();}catch(error){if(!response.headersSent)response.writeHead(503,{'content-type':'text/plain; charset=utf-8'});response.end('저장소 확인 불가: '+error.message);}
  });
}

export function withWaitSnapshots(tree, home) {
  const outDir = path.join(home, "out");
  let names;
  try {
    names = fs.readdirSync(outDir);
  } catch {
    return tree;
  }
  return tree.map((board) => ({
    ...board,
    roles: board.roles.map((role) => {
      const prefix = `${role.session}.wait-`;
      const fileName = names
        .filter((name) => name.startsWith(prefix) && name.endsWith(".txt"))
        .sort()
        .at(-1);
      if (!fileName) return role;
      try {
        const lines = fs
          .readFileSync(path.join(outDir, fileName), "utf8")
          .split("\n");
        while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
        return {
          ...role,
          waitSnapshot: {
            fileName,
            tail: lines.slice(-3).join("\n"),
          },
        };
      } catch {
        return role;
      }
    }),
  }));
}
