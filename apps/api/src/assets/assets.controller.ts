import { Controller, Get, NotFoundException, Param, Res, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { UI_ASSETS } from './asset-catalog.js';

/** Public UI artwork only. Never sign arbitrary object keys or user uploads. */
@Controller('ui-assets')
export class AssetsController {
  constructor(private readonly config: ConfigService) {}

  @Get(':name')
  get(@Param('name') name: string, @Res() reply: FastifyReply) {
    if (!Object.hasOwn(UI_ASSETS, name)) throw new NotFoundException('UI asset not found');
    const key = UI_ASSETS[name];
    if (!key) throw new NotFoundException('UI asset not found');
    const domain = this.config.get<string>('ASSET_CDN_DOMAIN');
    const secret = this.config.get<string>('ASSET_CDN_PRIVATE_KEY');
    reply.header('Cache-Control', 'no-store');
    if (!domain && !secret && this.config.get('NODE_ENV') !== 'production') {
      return reply.redirect('/' + key.split('/').slice(3).join('/'), 302);
    }
    if (!domain || !/^[a-zA-Z0-9.-]+$/.test(domain) || !secret) {
      throw new ServiceUnavailableException('UI asset CDN is not configured');
    }
    const path = '/' + key;
    const expires = Math.floor(Date.now() / 1000) + 1800;
    // Aliyun CDN Type A, matching Calendar's existing private-origin configuration.
    const signature = createHash('md5').update(`${path}-${expires}-0-0-${secret}`).digest('hex');
    return reply.redirect(`https://${domain}${path}?auth_key=${expires}-0-0-${signature}`, 302);
  }
}
