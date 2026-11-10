import path from 'node:path';

export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// 원문에 적힌 문서 경로를 HTTP 서버 경로로 바꾸지 않는다.
export function documentLink(label,target,{sourcePath='',path:cardPath=''}={}) {
 const e=escapeHtml,raw=String(target).trim();
 if(/^https?:\/\//i.test(raw)&&!/[\u0000-\u0020\u007f\\]/u.test(raw)) {
  try {const url=new URL(raw);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return `<a href="${e(url.href)}" target="_blank" rel="noopener noreferrer">${e(label)}</a>`;}catch { /* 파싱 실패한 링크는 아래에서 경로 또는 텍스트로 표시한다. */ }
 }
 if(!/^[a-z][a-z\d+.-]*:/i.test(raw)&&!raw.startsWith('//')&&!/[\u0000-\u001f\u007f]/u.test(raw)) {
  const source=sourcePath||cardPath;
  const resolved=source?path.resolve(path.dirname(source),raw.split('#')[0]||path.basename(source)):raw;
  return `<span class="dw-document-reference" title="${e(source?'원본 기준: '+resolved:'원본 경로 확인 필요')}">${e(label)} <code>${e(raw)}</code></span>`;
 }
 return `${e(label)} <code>${e(raw)}</code>`;
}
function inline(text,source) {
 const pattern=/(`[^`]+`|!?\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*)/g;
 let html='',last=0;
 for(const m of text.matchAll(pattern)) {
  html+=escapeHtml(text.slice(last,m.index));const t=m[0];
  if(t.startsWith('`'))html+=`<code>${escapeHtml(t.slice(1,-1))}</code>`;
  else if(t.startsWith('**'))html+=`<strong>${escapeHtml(t.slice(2,-2))}</strong>`;
  // source.link가 있으면 그 문서 종류의 링크 표시를 쓴다(길잡이: 저장소 문서 경로를 글자로).
  else {const link=t.match(/^(!?)\[([^\]]+)\]\((.+)\)$/);html+=(link[1]?'이미지: ':'')+(source.link??documentLink)(link[2],link[3],source);}
  last=m.index+t.length;
 }
 return html+escapeHtml(text.slice(last));
}
export function renderCardDocument(body,source={}) {
 const lines=String(body??'').replace(/\r\n?/g,'\n').split('\n');let i=0;const out=[];
 const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(s=>s.trim());
 const tableRule=line=>line&&/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
 while(i<lines.length) {
  const line=lines[i];
  if(!line.trim()){i++;continue;}
  const fence=line.match(/^\s*(`{3,}|~{3,})/);
  if(fence){const body=[];i++;while(i<lines.length&&!lines[i].trim().startsWith(fence[1]))body.push(lines[i++]);if(i<lines.length)i++;out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);continue;}
  const heading=line.match(/^\s*(#{1,6})\s+(.+)$/);
  if(heading){const level=Math.min(heading[1].length+1,6);out.push(`<h${level}>${inline(heading[2],source)}</h${level}>`);i++;continue;}
  if(tableRule(lines[i+1])) {
   const headers=cells(line);i+=2;const rows=[];while(i<lines.length&&lines[i].includes('|')&&lines[i].trim())rows.push(cells(lines[i++]));
   out.push(`<div class="dw-document-table"><table><thead><tr>${headers.map(c=>`<th scope="col">${inline(c,source)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${headers.map((_,n)=>`<td>${inline(row[n]||'',source)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);continue;
  }
  const list=line.match(/^\s*(?:[-*+] |\d+[.)] )(.+)$/);
  if(list){const ordered=/^\s*\d/.test(line),tag=ordered?'ol':'ul',items=[];while(i<lines.length){const m=lines[i].match(ordered?/^\s*\d+[.)] (.+)$/:/^\s*[-*+] (.+)$/);if(!m)break;items.push(`<li>${inline(m[1],source)}</li>`);i++;}out.push(`<${tag}>${items.join('')}</${tag}>`);continue;}
  if(/^\s*>/.test(line)){out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/,''),source)}</blockquote>`);i++;continue;}
  const paragraph=[line];i++;while(i<lines.length&&lines[i].trim()&&!/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|`{3}|~{3})/.test(lines[i])&&!tableRule(lines[i+1]))paragraph.push(lines[i++]);
  out.push(`<p>${paragraph.map(x=>inline(x,source)).join('<br>')}</p>`);
 }
 return out.join('')||'<p>작업 내용이 없습니다.</p>';
}
