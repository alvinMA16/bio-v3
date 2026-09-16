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
  @Get(':id/file') async file(@Param('id') id: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('bio-file-session='))?.slice('bio-file-session='.length);
    // Browsers may retain the previous preview's Basic credentials after rollout.
    const authorization = /^Bearer /i.test(request.headers.authorization ?? '') ? request.headers.authorization : (cookie ? `Bearer ${cookie}` : request.headers.authorization);
    const user = await this.memory?.resolveIdentity(authorization);
    const { item, buffer } = await this.materials.original(id, user);
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `${item.kind === 'image' || item.mimeType === 'application/pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.filename)}`)
      .type(item.mimeType).send(buffer);
  }
}
