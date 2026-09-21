/** Shared incremental presentation-markup parser. Destination policies preserve different content.
 * Emitted text is immutable. Parsing depends on characters, never provider chunk boundaries.
 */
export type TextTarget = 'speech' | 'document';

export class MarkupTextStream {
  constructor(private readonly target: TextTarget = 'speech') {}
  private raw = '';
  private pending = '';
  private output = '';
  private previous = '';
  private lineStart = true;
  private emphasis: string[] = [];
  private inlineCode = '';
  private fence = '';
  private destinationDepth = 0;
  private destinationEscaped = false;
  private finished = false;

  push(delta: string): string {
    if (this.finished) throw new Error('Text normalization already completed');
    this.raw += delta;
    let result = '';
    // A fixed character-wise feed also makes bounded lookahead independent of chunk size.
    for (const char of delta) { this.pending += char; result += this.drain(false); }
    return result;
  }

  finish(snapshot: string): { delta: string; text: string } {
    if (this.finished) throw new Error('Text normalization already completed');
    if (!snapshot.startsWith(this.raw)) throw new Error('Text snapshot changed after streaming');
    const delta = this.push(snapshot.slice(this.raw.length)) + this.drain(true);
    if (this.target === 'document' && this.destinationDepth) throw new Error('文稿链接格式未闭合，请修正后重新提交；本批次未保存。');
    this.finished = true;
    return { delta, text: this.output };
  }

  private consume(count: number, text: string): string {
    const raw = this.pending.slice(0, count);
    this.pending = this.pending.slice(count);
    this.previous = raw.at(-1) ?? this.previous;
    this.lineStart = raw.endsWith('\n') || this.lineStart && /^[ \t]*$/.test(raw);
    this.output += text;
    return text;
  }

  private drain(final: boolean): string {
    let result = '';
    while (this.pending) {
      const text = this.pending, char = text[0]!;
      const take = (count: number, value = '') => { result += this.consume(count, value); };
      if (this.destinationDepth) {
        if (this.destinationEscaped) this.destinationEscaped = false;
        else if (char === '\\') this.destinationEscaped = true;
        else if (char === '(') this.destinationDepth++;
        else if (char === ')') this.destinationDepth--;
        else if (char === '\n') {
          if (this.target === 'document') throw new Error('文稿链接格式未闭合，请修正后重新提交；本批次未保存。');
          this.destinationDepth = 0; take(1, '\n'); continue;
        }
        take(1, this.target === 'document' ? this.destinationDepth ? char : '）' : ''); continue;
      }
      if (this.lineStart && !this.inlineCode) {
        const run = /^[`~]+/.exec(text)?.[0];
        if (run && (run[0] === '`' || run[0] === '~') && [...run].every(value => value === run[0])) {
          if (run.length === text.length && !final && run.length < 256) break;
          if (run.length >= 3 && (!this.fence || run[0] === this.fence[0] && run.length >= this.fence.length)) {
            const end = text.indexOf('\n');
            if (end < 0 && !final && text.length < 256) break;
            if (this.target === 'document') throw new Error('非代码段落包含 Markdown 代码围栏，请将代码放入 kind=code 的独立块；本批次未保存。');
            const closing = !!this.fence;
            // Closing fences only contain optional whitespace after the delimiter.
            if (!closing || /^[ \t]*(?:\n|$)/.test(text.slice(run.length))) {
              this.fence = closing ? '' : run;
              take(end < 0 ? text.length : end + 1, closing ? '' : '\n'); continue;
            }
          }
        }
        if (!this.fence) {
          if (/^(?:#{1,6}|[>+*-]|\d{1,9}[.)]?)$/.test(text) && !final) break;
          const prefix = /^(?:#{1,6}|[>+*-]|\d{1,9}[.)])[ \t]+/.exec(text);
          if (prefix) {
            const ordinal = /^(\d+)[.)]/.exec(prefix[0]);
            take(prefix[0].length, this.target === 'document' && ordinal ? `${ordinal[1]}、` : '');
            continue;
          }
          // Pipe tables are a presentation construct. Buffer at most one bounded row.
          if (char === '|') {
            const end = text.indexOf('\n');
            if (end < 0 && !final && text.length < 1024) break;
            const row = text.slice(0, end < 0 ? text.length : end);
            const content = /^[| :\t-]+$/.test(row) ? '' : row.replace(/^\||\|$/g, '').split('|').map(cell => normalizeText(cell.trim(), this.target)).join(this.target === 'speech' ? '，' : '\t');
            take(end < 0 ? text.length : end + 1, content + '\n'); continue;
          }
        }
      }
      if (this.fence) { take(1, char); continue; }
      if (char === '`') {
        const run = /^`+/.exec(text)![0];
        if (run.length === text.length && !final && run.length < 256) break;
        if (!this.inlineCode) { this.inlineCode = run; take(run.length); continue; }
        if (this.inlineCode === run) { this.inlineCode = ''; take(run.length); continue; }
        take(run.length, run); continue;
      }
      if (this.inlineCode) { take(1, char); continue; }
      if (char === '\\') {
        if (text.length === 1 && !final) break;
        if (text[1] && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(text[1])) { take(2, text[1]); continue; }
      }
      if (char === '!' && text.length === 1 && !final) break;
      if (char === '[' || text.startsWith('![')) {
        const start = char === '!' ? 2 : 1;
        let depth = 1, end = start, escaped = false;
        for (; end < text.length; end++) {
          if (escaped) { escaped = false; continue; }
          if (text[end] === '\\') { escaped = true; continue; }
          if (text[end] === '[') depth++;
          if (text[end] === ']' && --depth === 0) break;
        }
        if ((end >= text.length || end === text.length - 1) && !final && text.length < 512 && !text.includes('\n')) break;
        if (end < text.length && text[end + 1] === '(') {
          const label = normalizeText(text.slice(start, end), this.target);
          take(end + 2, label + (this.target === 'document' ? '（' : '')); this.destinationDepth = 1; continue;
        }
      }
      if (char === '*' || char === '_' || char === '~') {
        let size = 1;
        while (text[size] === char) size++;
        if (size === text.length && !final && size < 256) break;
        const run = text.slice(0, size), next = text[size];
        const open = this.emphasis.at(-1);
        const closing = open && run.startsWith(open) && !/\s/.test(this.previous);
        const boundary = !/[\p{Script=Latin}\p{N}_]/u.test(this.previous)
          || char === '*' && size >= 2 && !(/[\p{Script=Latin}\p{N}_]/u.test(this.previous) && /\p{N}/u.test(next ?? ''));
        const opening = !!next && !/\s/.test(next) && boundary
          && (char !== '~' || size === 2);
        if (closing) { this.emphasis.pop(); take(open.length); continue; }
        if (opening) { this.emphasis.push(run); take(size); continue; }
        take(size, run); continue;
      }
      // Do not emit the first half of a surrogate pair, including providers splitting UTF-16.
      if (/^[\uD800-\uDBFF]$/.test(text) && !final) break;
      const first = String.fromCodePoint(text.codePointAt(0)!);
      take(first.length, first);
    }
    return result;
  }
}

export function normalizeText(text: string, target: TextTarget): string {
  return new MarkupTextStream(target).finish(text).text;
}
