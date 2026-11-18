import { StringDecoder } from 'node:string_decoder';

// 保留跨数据块的 UTF-8 字符和半行，阻止异常长行占用无限内存。
export function readLines(onLine, maxBytes) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  function consume(text) {
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      pending += lines[index];
      if (Buffer.byteLength(pending) > maxBytes) throw new Error('STREAM_LINE_TOO_LARGE');
      if (index < lines.length - 1) {
        onLine(pending.trimEnd());
        pending = '';
      }
    }
  }
  return {
    write(chunk) { consume(decoder.write(chunk)); },
    finish() {
      consume(decoder.end());
      if (pending) onLine(pending.trimEnd());
      pending = '';
    },
  };
}
