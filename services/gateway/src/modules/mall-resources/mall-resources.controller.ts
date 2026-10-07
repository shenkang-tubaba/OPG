import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { tenantControllerPaths, resolveAppSlug } from '../../common/utils/controller-paths';
import { MallResourcesService } from './mall-resources.service';

type AuthRequest = {
  user?: { id?: string; user_id?: string; sub?: string };
  params?: Record<string, string>;
  query?: Record<string, string>;
};

/**
 * 用户端商城资源接口（可选鉴权）
 * 权益模型（2026-10）：资源介绍对所有人开放（含未登录游客），
 * 登录且持有任意有效会员（VIP/SVIP）才返回 download_url。
 * GET  /:app/v1/mall/resources          资源列表（未登录游客可看介绍，无链接）
 * GET  /:app/v1/mall/resources/:id      资源详情（同上）
 * GET  /:app/v1/mall/membership         我的会员档位（需登录）
 */
@ApiTags('MallResources')
@Controller(tenantControllerPaths('mall', true))
@ApiBearerAuth()
export class MallResourcesController {
  constructor(private readonly service: MallResourcesService) {}

  @Get('resources')
  @Public()
  @ApiOperation({ summary: '商城资源列表（游客可看介绍；支持 category/tag/keyword/sort=download_count|time|title）' })
  async list(
    @Req() req: AuthRequest,
    @Query('category') category?: string,
    @Query('tag') tag?: string,
    @Query('keyword') keyword?: string,
    @Query('sort') sort?: string,
  ) {
    const appSlug = String(resolveAppSlug(req) || '');
    const userId = String(req.user?.id || req.user?.user_id || req.user?.sub || '');
    return this.service.listForUser(appSlug, userId, category || undefined, tag || undefined, keyword || undefined, sort || undefined);
  }

  @Post('resources/:id/track-download')
  @Public()
  @ApiOperation({ summary: '下载量上报（复制/打开网盘时调用，+1）' })
  async trackDownload(@Req() req: AuthRequest, @Param('id') id: string) {
    const appSlug = String(resolveAppSlug(req) || '');
    return this.service.trackDownload(appSlug, id);
  }

  @Get('resources/:id')
  @Public()
  @ApiOperation({ summary: '商城资源详情（游客可看介绍；VIP/SVIP 返回下载链接）' })
  async detail(@Req() req: AuthRequest, @Param('id') id: string) {
    const appSlug = String(resolveAppSlug(req) || '');
    const userId = String(req.user?.id || req.user?.user_id || req.user?.sub || '');
    return this.service.getForUser(appSlug, userId, id);
  }

  @Get('membership')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '我的会员档位（NONE/VIP/SVIP）' })
  async membership(@Req() req: AuthRequest) {
    const appSlug = String(resolveAppSlug(req) || '');
    const appId = await this.service.resolveAppId(appSlug);
    const userId = String(req.user?.id || req.user?.user_id || req.user?.sub || '');
    const tier = await this.service.resolveMemberTier(appId, userId);
    return { tier };
  }
}
