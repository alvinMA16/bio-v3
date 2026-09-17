import { GoneException, NotFoundException } from '@nestjs/common';
import type { PanelAttachment } from '@bio/contracts';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

export interface MaterialReference {
  attachmentId: string;
  materialId: string;
  title: string;
  originalStatus?: PanelAttachment['originalStatus'];
}

export function unavailableOriginal(error: unknown): PanelAttachment['originalStatus'] {
  return error instanceof GoneException ? 'deleted' : error instanceof NotFoundException ? 'unavailable' : undefined;
}

export function originalUnavailableNotice(item: MaterialReference): string {
  return JSON.stringify({ type: 'bio_material_original_unavailable', ...item,
    instruction: `${item.originalStatus === 'deleted' ? '原文件已删除' : '原文件不可用'}。历史对话仍保留，可以基于已有对话继续讨论；历史回复、摘录或工具结果只是过去的记录，不代表现在可访问原件。不能重新读取、核对原文、查看页面或推断未读内容。仅在用户需要原件时说明并请其重新上传，不必在普通对话中反复提醒。`,
  });
}

/** Only transform the model's message copy: persisted history is never rewritten. */
export function materialHistoryContext(items: MaterialReference[], refresh: () => Promise<void>): ExtensionFactory {
  return pi => {
    pi.on('context', async event => {
      await refresh();
      const missing = items.filter(item => item.originalStatus);
      const messages = event.messages.map(message => {
        if (message.role !== 'custom' || message.customType !== 'bio_material_attachment') return message;
        const id = (message.details as { attachmentId?: string } | undefined)?.attachmentId;
        const item = missing.find(item => item.attachmentId === id);
        // Do not replay historical image pixels or a full extracted file as a fresh original.
        return item ? { ...message, content: originalUnavailableNotice(item) } : message;
      });
      // Keep the availability boundary even after the old attachment message is compacted.
      return { messages: [...missing.map(item => ({ role: 'custom' as const, customType: 'bio_material_availability',
        content: originalUnavailableNotice(item), display: false, timestamp: Date.now(),
      })), ...messages] };
    });
  };
}
