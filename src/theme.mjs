// 대시보드 다크 모드(2026-09-24 [kyle]). 색은 여러 파일의 스타일에 직접 적혀 있어(서로 다른 색 약 190가지)
// 파일마다 고치지 않고, 페이지를 내보내기 직전에 한 곳에서 색 변수로 바꾼다. 밝은 값은 원래 색 그대로라
// 밝은 화면은 달라지지 않는다. 어두운 값은 색상은 두고 밝기를 뒤집어 계산한다. 기본은 시스템 설정을 따르고,
// 테마 단추로 자동·어둡게·밝게를 고르면 이 브라우저에만 기억한다.
const HEX=/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const NAMED=/([:\s,(])(white|black)(?=[\s;}!,)]|$)/g;

const clamp=(x,lo=0,hi=1)=>Math.min(hi,Math.max(lo,x));
function parse(hex){
 let h=hex.slice(1);
 if(h.length<=4)h=[...h].map(c=>c+c).join('');
 return {r:parseInt(h.slice(0,2),16)/255,g:parseInt(h.slice(2,4),16)/255,b:parseInt(h.slice(4,6),16)/255,a:h.length===8?h.slice(6,8):''};
}
function toHsl({r,g,b}){
 const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2;
 if(max===min)return {h:0,s:0,l};
 const d=max-min,s=l>0.5?d/(2-max-min):d/(max+min);
 const h=max===r?(g-b)/d+(g<b?6:0):max===g?(b-r)/d+2:(r-g)/d+4;
 return {h:h/6,s,l};
}
function fromHsl({h,s,l}){
 if(s===0)return {r:l,g:l,b:l};
 const q=l<0.5?l*(1+s):l+s-l*s,p=2*l-q;
 const t=x=>{x=(x+1)%1;return x<1/6?p+(q-p)*6*x:x<1/2?q:x<2/3?p+(q-p)*(2/3-x)*6:p;};
 return {r:t(h+1/3),g:t(h),b:t(h-1/3)};
}
const hex2=x=>Math.round(clamp(x)*255).toString(16).padStart(2,'0');

// 밝기 뒤집기: 흰 배경(1) → 0.10, 진한 글자(0.12) → 약 0.83, 중간 색은 중간에 머문다.
// 어두워진 넓은 바탕색(연한 노랑·연한 초록 등)은 채도를 낮춰 탁하게 튀지 않게 한다.
export function darkColor(hex){
 const c=parse(hex),hsl=toHsl(c);
 // 반투명한 어두운 색(그림자·덮개)은 어두운 화면에서도 어두워야 하므로 그대로 둔다.
 if(c.a&&hsl.l<0.5)return normalize(hex);
 const l=0.1+(1-hsl.l)*0.84;
 const s=hsl.s*(l<0.3?0.5:0.85);
 const {r,g,b}=fromHsl({h:hsl.h,s,l});
 return '#'+hex2(r)+hex2(g)+hex2(b)+c.a;
}

const normalize=hex=>{const {r,g,b,a}=parse(hex);return '#'+hex2(r)+hex2(g)+hex2(b)+a;};
const varName=hex=>'--kc-'+normalize(hex).slice(1).toLowerCase();

// 선언 안의 색만 바꾼다. 선택자(#abc-panel 같은 아이디)를 색으로 읽지 않도록 { } 안의 선언부만 다룬다.
function themeDeclarations(text,used){
 return text.replace(HEX,m=>{used.add(normalize(m).toLowerCase());return `var(${varName(m)})`;})
  .replace(NAMED,(m,lead,word)=>{const hex=word==='white'?'#ffffff':'#000000';used.add(hex);return lead+`var(${varName(hex)})`;});
}
// @media·@supports·@keyframes처럼 규칙을 품은 블록은 안으로 들어가고, 나머지 블록은 선언부로 본다.
function themeCss(css,used){
 let out='',i=0;
 while(i<css.length){
  const open=css.indexOf('{',i);
  if(open<0){out+=css.slice(i);break;}
  const prelude=css.slice(i,open);
  let depth=1,j=open+1;
  while(j<css.length&&depth){if(css[j]==='{')depth++;else if(css[j]==='}')depth--;j++;}
  const inner=css.slice(open+1,j-1);
  out+=prelude+'{'+(/^\s*@(media|supports|container|layer|keyframes|-webkit-keyframes)/.test(prelude.split(/[;}]/).pop())?themeCss(inner,used):themeDeclarations(inner,used))+'}';
  i=j;
 }
 return out;
}

function themeVariables(used){
 const colors=[...used].sort();
 const light=colors.map(c=>`${varName(c)}:${c}`).join(';');
 const dark=colors.map(c=>`${varName(c)}:${darkColor(c)}`).join(';');
 return `:root{color-scheme:light;${light}}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${dark}}}:root[data-theme="dark"]{color-scheme:dark;${dark}}`;
}

// React 번들도 기존 화면과 같은 색·자동/밝게/어둡게 규칙으로 빌드한다.
export function themeStyleSheet(css){
 const used=new Set(),themed=themeCss(css,used);
 return themeVariables(used)+'\n'+themed;
}

// 페이지 HTML의 <style> 블록과 style="" 속성의 색을 변수로 바꾸고, 밝은·어두운 값 정의를 앞에 붙인다.
export function applyTheme(html){
 const used=new Set();
 let out=html.replace(/<style>([\s\S]*?)<\/style>/g,(m,css)=>`<style>${themeCss(css,used)}</style>`)
  .replace(/ style="([^"]*)"/g,(m,css)=>` style="${themeDeclarations(css,used)}"`);
 const defs=`<style>${themeVariables(used)}</style>`;
 return out.replace('<style>',`${themeHeadScript}${defs}<style>`);
}

// 기억한 테마를 그리기 전에 먼저 붙여 밝은 화면이 번쩍이지 않게 한다.
export const themeHeadScript=`<script>try{const t=localStorage.getItem('kadan-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t;}catch{}</script>`;
export const themeToggleHtml=`<button type="button" class="dw-theme" data-theme-toggle aria-label="화면 테마 바꾸기">테마: 자동</button>`;
export const themeToggleStyle=`.dw-theme{font-size:12px;padding:4px 10px;border-radius:999px;white-space:nowrap;margin-left:auto}.dw-theme+.dw-more{margin-left:8px}`;
export const themeToggleScript=`
 (()=>{
  const order=['auto','dark','light'],label={auto:'자동',dark:'어둡게',light:'밝게'};
  const current=()=>document.documentElement.dataset.theme||'auto';
  const paint=()=>{for(const b of document.querySelectorAll('[data-theme-toggle]'))b.textContent='테마: '+label[current()];};
  document.addEventListener('click',event=>{
   if(!event.target.closest||!event.target.closest('[data-theme-toggle]'))return;
   const next=order[(order.indexOf(current())+1)%order.length];
   if(next==='auto')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=next;
   try{if(next==='auto')localStorage.removeItem('kadan-theme');else localStorage.setItem('kadan-theme',next);}catch{}
   paint();
  });
  paint();
 })();
`;
