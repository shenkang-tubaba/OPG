import { Body, Controller, Delete, Get, Injectable, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Inject } from '@nestjs/common';
import { PRISMA_CLIENT } from '../../config/database.module';
import { PrismaClient } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { MallResourcesService } from './mall-resources.service';
import { LinkCheckWorkerService } from './link-check.worker.service';

/**
 * 平台管理端：商城资源 CRUD + 手动触发链接巡检
 * 路由形态与 redeem 一致：/api/v1/platform-admin/apps/:app_id/mall-resources
 */
@ApiTags('MallResourcesAdmin')
@Controller(tenantControllerPaths('platform-admin/apps/:app_id/mall-resources', true))
@UseGuards(JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class MallResourcesPlatformController {
  constructor(
    private readonly service: MallResourcesService,
    private readonly linkCheckWorker: LinkCheckWorkerService,
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
  ) {}

  /** app_id 参数支持 uuid 或 slug */
  private async resolveAppId(appIdOrSlug: string): Promise<string> {
    const v = String(appIdOrSlug || '').trim();
    if (!v) throw new Error('app_id 不能为空');
    if (/^[0-9a-f-]{36}$/i.test(v)) return v;
    return this.service.resolveAppId(v);
  }

  @Get()
  @ApiOperation({ summary: '资源列表（管理端，全字段）' })
  async list(@Param('app_id') appIdOrSlug: string) {
    const appId = await this.resolveAppId(appIdOrSlug);
    return this.service.adminList(appId, {});
  }

  @Post()
  @ApiOperation({ summary: '新建资源' })
  async create(@Param('app_id') appIdOrSlug: string, @Body() body: Record<string, unknown>) {
    const appId = await this.resolveAppId(appIdOrSlug);
    return this.service.adminUpsert(appId, body);
  }

  @Put(':id')
  @ApiOperation({ summary: '更新资源' })
  async update(@Param('app_id') appIdOrSlug: string, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const appId = await this.resolveAppId(appIdOrSlug);
    return this.service.adminUpsert(appId, body, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除资源' })
  async remove(@Param('app_id') appIdOrSlug: string, @Param('id') id: string) {
    const appId = await this.resolveAppId(appIdOrSlug);
    return this.service.adminDelete(appId, id);
  }

  @Post('check-links')
  @ApiOperation({ summary: '手动触发全量链接巡检' })
  async checkLinks(@Param('app_id') appIdOrSlug: string) {
    const appId = await this.resolveAppId(appIdOrSlug);
    return this.linkCheckWorker.checkAll(appId);
  }

  // ===== 标签管理 =====

  @Get('tags')
  @ApiOperation({ summary: '标签列表（含引用计数）' })
  async listTags(@Param('app_id') appIdOrSlug: string) {
    const appId = await this.resolveAppId(appIdOrSlug);
    return this.service.adminListTags(appId);
  }

  @Post('tags')
  @ApiOperation({ summary: '新建标签' })
  async createTag(@Param('app_id') appIdOrSlug: string, @Body() body: Record<string, unknown>) {
    const appId = await this.resolveAppId(appIdOrSlug);
    return this.service.adminCreateTag(appId, body);
  }

  @Put('tags/:tag_id')
  @ApiOperation({ summary: '重命名标签（同步更新资源内嵌 tags）' })
  async updateTag(
    @Param('app_id') appIdOrSlug: string,
    @Param('tag_id') tagId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const appId = await this.resolveAppId(appIdOrSlug);
    return this.service.adminUpdateTag(appId, tagId, body);
  }

  @Delete('tags/:tag_id')
  @ApiOperation({ summary: '删除标签（同步从资源中移除）' })
  async deleteTag(@Param('app_id') appIdOrSlug: string, @Param('tag_id') tagId: string) {
    const appId = await this.resolveAppId(appIdOrSlug);
    return this.service.adminDeleteTag(appId, tagId);
  }
}
