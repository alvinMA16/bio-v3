/** Per-message sentence buffering. Tool arguments and panel content never enter this buffer. */
export class SpokenSegments {
  private messages = new Map<string, { text: string; sent: number }>();
  push(id: string, text: string, completed = false): string[] {
    const entry = this.messages.get(id) ?? { text: '', sent: 0 };
    if (completed) {
      // Completed snapshots must not replay prefixes already synthesized.
      if (!text.startsWith(entry.text.slice(0, entry.sent))) throw new Error('Speech snapshot changed after playback');
      entry.text = text;
    } else entry.text += text;
    this.messages.set(id, entry);
    const result: string[] = [];
    while (entry.sent < entry.text.length) {
      const pending = entry.text.slice(entry.sent);
      const match = /[。！？!?；;\n]/u.exec(pending);
      let size = match ? match.index + 1 : completed ? pending.length : 0;
      // Bound first-audio latency for long unpunctuated speech.
      if (!size && pending.length >= 100) size = 100;
      if (!size) break;
      const part = pending.slice(0, size).trim();
      entry.sent += size;
      if (/[\p{L}\p{N}]/u.test(part)) result.push(part);
    }
    return result;
  }
}
