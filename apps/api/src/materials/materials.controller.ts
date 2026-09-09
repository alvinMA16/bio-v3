import { BadRequestException, Body, Controller, Delete, Get, Param, Put, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IsString, MaxLength, Matches } from 'class-validator';
import { MaterialsService } from './materials.service.js';
class EditMaterialDto {
  @IsString() @Matches(/\S/) @MaxLength(300) title!: string;
  @IsString() @MaxLength(2000) description!: string;
}
@Controller('materials')
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}
  @Get() list() { return this.materials.list(); }
  @Get(':id') get(@Param('id') id: string) { return this.materials.get(id); }
  @Post() async upload(@Req() request: FastifyRequest) {
    const file = await request.file();
    if (!file) throw new BadRequestException('请选择文件');
    const buffer = await file.toBuffer();
    return this.materials.upload(file.filename, buffer);
  }
  @Put(':id') update(@Param('id') id: string, @Body() body: EditMaterialDto) { return this.materials.update(id, body.title, body.description); }
  @Delete(':id') remove(@Param('id') id: string) { return this.materials.remove(id); }
  @Get(':id/file') async file(@Param('id') id: string, @Res() reply: FastifyReply) {
    const { item, buffer } = await this.materials.original(id);
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `${item.kind === 'image' || item.mimeType === 'application/pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.filename)}`)
      .type(item.mimeType).send(buffer);
  }
}
