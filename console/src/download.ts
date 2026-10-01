// 把一段字存成文件给用户下载（CSV 模板、不合格的行）：Blob 加 <a download>，只在本地生成，不经服务端。
// CSP 不管下载（没有 navigate-to），blob: 地址不用另开。地址在点完以后的下一轮释放：下载在 click() 里已经开始了
export function saveText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  // 先挂进文档再点：Firefox 不认没挂上的链接
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
