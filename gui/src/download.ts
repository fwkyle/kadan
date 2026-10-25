// 글을 파일로 내려받는다(서버가 만든 내보내기 JSON을 그대로 저장).
export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
