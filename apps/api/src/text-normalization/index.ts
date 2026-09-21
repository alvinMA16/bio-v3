import type { PanelBlock } from '@bio/contracts';
import { MarkupTextStream, normalizeText } from './markup-stream.js';

/** Speech and document callers share syntax recognition, with explicit output policies. */
export const createSpeechTextStream = () => new MarkupTextStream('speech');
export const normalizeSpeechText = (text: string) => normalizeText(text, 'speech');

export function normalizeDocumentBlock(block: PanelBlock): PanelBlock {
  // Code is literal content; neither markup nor escape sequences should be rewritten.
  return { ...block, text: block.kind === 'code' ? block.text : normalizeText(block.text, 'document') };
}

export const normalizeDocumentTitle = (title: string) => normalizeText(title, 'document');
