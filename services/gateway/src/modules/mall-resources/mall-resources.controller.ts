import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { tenantControllerPaths, resolveAppSlug } from '../../common/utils/controller-paths';
import { MallResourcesService } from './mall-resources.service';

type AuthRequest = {
  user?: { id?: string; user_id?: string; sub?: string };
  params?: Record<string, string>;
  query?: Record<string, string>;
};

/**
 * 用户端商城资源接口（JWT 鉴权）
 * GET  /:app/v1/mall/resources          资源列表（download_url 仅 SVIP 返回）
 * GET  /:app/v1/mall/resources/:id      资源详情
 * GET  /:app/v1/mall/membership         我的会员档位
 */
@ApiTags('MallResources')
@Controller(tenantControllerPaths('mall', true))
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MallResourcesController {
  constructor(private readonly service: MallResourcesService) {}

  @Get('resources')
  @ApiOperation({ summary: '商城资源列表（按会员档位过滤，SVIP 才返回下载链接）' })
  async list(@Req() req: AuthRequest, @Query('category') category?: string) {
    const appSlug = String(resolveAppSlug(req) || '');
    const userId = String(req.user?.id || req.user?.user_id || req.user?.sub || '');
    return this.service.listForUser(appSlug, userId, category || undefined);
  }

  @Get('resources/:id')
  @ApiOperation({ summary: '商城资源详情（按会员档位过滤）' })
  async detail(@Req() req: AuthRequest, @Param('id') id: string) {
    const appSlug = String(resolveAppSlug(req) || '');
    const userId = String(req.user?.id || req.user?.user_id || req.user?.sub || '');
    return this.service.getForUser(appSlug, userId, id);
  }

  @Get('membership')
  @ApiOperation({ summary: '我的会员档位（NONE/VIP/SVIP）' })
  async membership(@Req() req: AuthRequest) {
    const appSlug = String(resolveAppSlug(req) || '');
    const appId = await this.service.resolveAppId(appSlug);
    const userId = String(req.user?.id || req.user?.user_id || req.user?.sub || '');
    const tier = await this.service.resolveMemberTier(appId, userId);
    return { tier };
  }
}
