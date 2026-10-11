import { Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AdminGuard, type AdminRequest } from './admin.guard.js';
import { AdminService, page } from './admin.service.js';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly service: AdminService) {}
  @Get('me') me(@Req() req: AdminRequest) { return req.admin; }
  @Get('overview') overview() { return this.service.overview(); }
  @Get('users') users(@Query('q') q?: string,@Query('offset') offset?: string) { return this.service.users(q,page(offset)); }
  @Get('users/:user') user(@Param('user') user:string) { return this.service.userDetail(user); }
  @Get('sessions') async sessions(@Req() req:AdminRequest,@Query('user') user?:string,@Query('offset') offset?:string) {
    await this.service.audit(req.admin,'read_session_list',user); return this.service.sessions(user,page(offset));
  }
  @Get('sessions/:id') session(@Req() req:AdminRequest,@Param('id') id:string,@Query('offset') offset?:string) { return this.service.session(req.admin,id,page(offset)); }
  @Get('runs/:id/trace') trace(@Req() req:AdminRequest,@Param('id') id:string,@Query('offset') offset?:string) { return this.service.trace(req.admin,id,page(offset)); }
  @Get('jobs') jobs(@Query('user') user?:string,@Query('status') status?:string,@Query('offset') offset?:string) { return this.service.jobs(user,status,page(offset)); }
  @Post('jobs/:id/retry') retry(@Req() req:AdminRequest,@Param('id') id:string) { return this.service.retry(req.admin,id); }
  @Get('users/:user/documents') documents(@Param('user') user:string,@Query('offset') offset?:string) { return this.service.documentList(user,page(offset)); }
  @Get('users/:user/documents/:id') document(@Req() req:AdminRequest,@Param('user') user:string,@Param('id') id:string,@Query('offset') offset?:string) { return this.service.document(req.admin,user,id,page(offset)); }
  @Get('users/:user/documents/:id/revisions/:version') revision(@Req() req:AdminRequest,@Param('user') user:string,@Param('id') id:string,@Param('version') version:string) { return this.service.revision(req.admin,user,id,version); }
  @Get('users/:user/materials') materials(@Param('user') user:string,@Query('offset') offset?:string) { return this.service.materialList(user,page(offset)); }
  @Get('users/:user/materials/:id') material(@Req() req:AdminRequest,@Param('user') user:string,@Param('id') id:string) { return this.service.material(req.admin,user,id); }
  @Get('users/:user/materials/:id/file') async original(@Req() req:AdminRequest,@Res() reply:FastifyReply,@Param('user') user:string,@Param('id') id:string) {
    const {item,buffer}=await this.service.original(req.admin,user,id);
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff')
      .header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(item.filename).replace(/'/g,'%27')}`)
      .type(item.mimeType).send(buffer);
  }
  @Get('users/:user/memories') memories(@Req() req:AdminRequest,@Param('user') user:string,@Query('offset') offset?:string) { return this.service.memories(req.admin,user,page(offset)); }
  @Get('users/:user/memories/:id') memory(@Req() req:AdminRequest,@Param('user') user:string,@Param('id') id:string,@Query('version') version?:string) { return this.service.memory(req.admin,user,id,version); }
  @Get('logs') logs(@Query('offset') offset?:string) { return this.service.logs(page(offset)); }
  @Get('errors') errors(@Query('offset') offset?:string) { return this.service.errors(page(offset)); }
  @Get('services') services() { return this.service.services(); }
}
