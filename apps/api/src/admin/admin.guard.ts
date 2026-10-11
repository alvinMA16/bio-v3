import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { AdminService, type AdminActor } from './admin.service.js';

export type AdminRequest = FastifyRequest & { admin: AdminActor };
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly admin: AdminService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    context.switchToHttp().getResponse<FastifyReply>().header('Cache-Control', 'no-store');
    request.admin = await this.admin.authorize(request.headers.authorization, request.method !== 'GET');
    return true;
  }
}
