import { BadRequestException, Body, Controller, Delete, Get, Param, Put, Post, Req, Res, Optional } from '@nestjs/common';
import { MemoryService } from '../memory/memory.service.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IsString, MaxLength, Matches } from 'class-validator';
import { MaterialsService } from './materials.service.js';
class EditMaterialDto {
  @IsString() @Matches(/\S/) @MaxLength(300) title!: string;
  @IsString() @MaxLength(2000) description!: string;
}
@Controller('materials')
export class MaterialsController {
  constructor(private readonly materials: MaterialsService, @Optional() private readonly memory?: MemoryService) {}
  @Get() async list(@Req() request: FastifyRequest) { return this.materials.list(await this.memory?.resolveIdentity(request.headers.authorization)); }
  @Get(':id') async get(@Param('id') id: string, @Req() request: FastifyRequest) { return this.materials.get(id, await this.memory?.resolveIdentity(request.headers.authorization)); }
  @Post() async upload(@Req() request: FastifyRequest) {
    const user = await this.memory?.resolveIdentity(request.headers.authorization);
    const file = await request.file();
    if (!file) throw new BadRequestException('请选择文件');
    const buffer = await file.toBuffer();
    return this.materials.upload(file.filename, buffer, user);
  }
  @Put(':id') async update(@Param('id') id: string, @Body() body: EditMaterialDto, @Req() request: FastifyRequest) { return this.materials.update(id, body.title, body.description, await this.memory?.resolveIdentity(request.headers.authorization)); }
  @Delete(':id') async remove(@Param('id') id: string, @Req() request: FastifyRequest) { return this.materials.remove(id, await this.memory?.resolveIdentity(request.headers.authorization)); }
  private async fileUser(request: FastifyRequest) {
    const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('bio-file-session='))?.slice('bio-file-session='.length);
    // Browsers may retain the previous preview's Basic credentials after rollout.
    const authorization = /^Bearer /i.test(request.headers.authorization ?? '') ? request.headers.authorization : (cookie ? `Bearer ${cookie}` : request.headers.authorization);
    return this.memory?.resolveIdentity(authorization);
  }
  @Get(':id/thumbnail') async thumbnail(@Param('id') id: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const buffer = await this.materials.thumbnail(id, await this.fileUser(request));
    return reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store').type('image/webp').send(buffer);
  }
  @Get(':id/pages/:page') async pdfPage(@Param('id') id: string, @Param('page') page: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    if (!/^[1-9]\d{0,5}$/.test(page)) throw new BadRequestException('无效的页码');
    const result = await this.materials.pdfPage(id, Number(page), await this.fileUser(request));
    return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').send(result);
  }
  @Get(':id/file') async file(@Param('id') id: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const user = await this.fileUser(request);
    const { item, buffer } = await this.materials.original(id, user);
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `${item.kind === 'image' || item.mimeType === 'application/pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.filename)}`)
      .type(item.mimeType).send(buffer);
  }
}
