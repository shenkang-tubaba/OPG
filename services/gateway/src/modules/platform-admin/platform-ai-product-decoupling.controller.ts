import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AiConfigurationRevisionService } from '../ai-chat/ai-configuration-revision.service';
import { AiExecutionPlanResolverService } from '../ai-chat/ai-execution-plan-resolver.service';
import { AiPriceBookService } from '../ai-chat/ai-price-book.service';
import { AiRoutingService } from '../ai-chat/ai-routing.service';
import { AiUpstreamCatalogService } from '../ai-chat/ai-upstream-catalog.service';
import { PlatformAdminAiDebugJwtAuthGuard } from './guards/platform-admin-ai-debug-jwt-auth.guard';

function stringValue(value: unknown): string | null {
  const result = String(value ?? '').trim();
  return result || null;
}

function dateValue(value: unknown, field: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field} is invalid`);
  return date;
}

@ApiTags('PlatformAIProductDecoupling')
@Controller('/api/v1/platform-admin/ai')
@UseGuards(PlatformAdminAiDebugJwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class PlatformAiProductDecouplingController {
  constructor(
    private readonly upstreams: AiUpstreamCatalogService,
    private readonly prices: AiPriceBookService,
    private readonly revisions: AiConfigurationRevisionService,
    private readonly plans: AiExecutionPlanResolverService,
    private readonly routing: AiRoutingService,
  ) {}

  @Get('upstreams')
  @ApiOperation({ summary: '查询上游模型目录' })
  async listUpstreams(
    @Query('source_id') sourceId?: string,
    @Query('capability') capability?: string,
    @Query('include_inactive') includeInactive?: string,
  ) {
    return {
      items: await this.upstreams.list({
        source_id: sourceId,
        capability,
        include_inactive: includeInactive === 'true',
      }),
    };
  }

  @Post('upstreams')
  @ApiOperation({ summary: '保存上游模型身份' })
  async upsertUpstream(@Req() req: any, @Body() body: Record<string, unknown>) {
    return this.upstreams.upsert({
      source_id: String(body.source_id || ''),
      upstream_key: String(body.upstream_key || ''),
      upstream_model: String(body.upstream_model || ''),
      capability: String(body.capability || ''),
      billing_scope: stringValue(body.billing_scope) || 'default',
      metadata_json: body.metadata_json && typeof body.metadata_json === 'object'
        ? body.metadata_json as Record<string, unknown>
        : undefined,
      is_active: body.is_active !== false,
      actor_user_id: req.user?.id || null,
    });
  }

  @Put('upstreams/:upstream_model_id')
  @ApiOperation({ summary: '修改上游模型身份' })
  async updateUpstream(
    @Req() req: any,
    @Param('upstream_model_id') upstreamModelId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.upstreams.update(upstreamModelId, {
      upstream_key: String(body.upstream_key || ''),
      upstream_model: String(body.upstream_model || ''),
      capability: String(body.capability || ''),
      billing_scope: stringValue(body.billing_scope) || 'default',
      metadata_json: body.metadata_json && typeof body.metadata_json === 'object'
        ? body.metadata_json as Record<string, unknown>
        : undefined,
      is_active: body.is_active !== false,
      actor_user_id: req.user?.id || null,
    });
  }

  @Get('products/:model_id/sell-price')
  @ApiOperation({ summary: '查询产品销售价版本' })
  async getSellPrice(@Param('model_id') modelId: string) {
    return { item: await this.prices.resolveSellPrice(modelId) };
  }

  @Post('products/:model_id/sell-price')
  @ApiOperation({ summary: '创建产品销售价版本' })
  async createSellPrice(
    @Req() req: any,
    @Param('model_id') modelId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const rates = body.rates_json;
    if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
      throw new BadRequestException('rates_json is required');
    }
    if (stringValue(body.app_id)) {
      throw new BadRequestException('App-specific sell prices are not supported');
    }
    return this.prices.createSellPriceVersion({
      global_model_id: modelId,
      status: (stringValue(body.status) as any) || 'draft',
      replace_active: body.replace_active === true,
      valid_from: dateValue(body.valid_from, 'valid_from'),
      valid_to: body.valid_to ? dateValue(body.valid_to, 'valid_to') || null : null,
      currency: stringValue(body.currency) || 'RMB',
      rates_json: rates as any,
      is_explicitly_free: body.is_explicitly_free === true,
      reason: stringValue(body.reason),
      actor_user_id: req.user?.id || null,
    });
  }

  @Post('upstreams/:upstream_model_id/cost-price')
  @ApiOperation({ summary: '创建上游成本价版本' })
  async createCostPrice(
    @Req() req: any,
    @Param('upstream_model_id') upstreamModelId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const rates = body.rates_json;
    if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
      throw new BadRequestException('rates_json is required');
    }
    return this.prices.createUpstreamCostVersion({
      upstream_model_id: upstreamModelId,
      status: (stringValue(body.status) as any) || 'draft',
      replace_active: body.replace_active === true,
      valid_from: dateValue(body.valid_from, 'valid_from'),
      valid_to: body.valid_to ? dateValue(body.valid_to, 'valid_to') || null : null,
      currency: stringValue(body.currency) || 'RMB',
      rates_json: rates as any,
      source_snapshot_json: body.source_snapshot_json && typeof body.source_snapshot_json === 'object'
        ? body.source_snapshot_json as Record<string, unknown>
        : {},
      reason: stringValue(body.reason),
      actor_user_id: req.user?.id || null,
    });
  }

  @Get('upstreams/:upstream_model_id/cost-price')
  @ApiOperation({ summary: '查询上游当前成本价版本' })
  async getCostPrice(@Param('upstream_model_id') upstreamModelId: string) {
    return { item: await this.prices.resolveUpstreamCost(upstreamModelId) };
  }

  @Get('products/:model_id/routes')
  @ApiOperation({ summary: '查询产品请求变体路由' })
  async listRoutes(@Param('model_id') modelId: string) {
    return this.routing.listGlobalModelSourceRoutes(modelId);
  }

  @Put('products/:model_id/routes')
  @ApiOperation({ summary: '保存产品请求变体路由' })
  async replaceRoutes(
    @Req() req: any,
    @Param('model_id') modelId: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!Array.isArray(body.items)) {
      throw new BadRequestException('items is required');
    }
    if (body.membership_route_enabled !== undefined) {
      if (typeof body.membership_route_enabled !== 'boolean') {
        throw new BadRequestException('membership_route_enabled must be a boolean');
      }
      await this.routing.updateGlobalModel(modelId, String(req.user?.id || ''), {
        membership_route_enabled: body.membership_route_enabled,
        source_routes: body.items as any,
      });
      return this.routing.listGlobalModelSourceRoutes(modelId);
    }
    return this.routing.replaceGlobalModelSourceRoutes(modelId, req.user?.id || null, {
      items: body.items as Array<Record<string, unknown>>,
    });
  }

  @Get('revisions/active')
  @ApiOperation({ summary: '查询当前 AI 配置版本' })
  async getActiveRevision() {
    return { revision: await this.revisions.getActiveRevisionNumber(true) };
  }

  @Post('revisions')
  @ApiOperation({ summary: '创建待发布 AI 配置版本' })
  async createRevision(@Req() req: any, @Body() body: Record<string, unknown>) {
    if (!body.manifest || typeof body.manifest !== 'object' || Array.isArray(body.manifest)) {
      throw new BadRequestException('manifest is required');
    }
    return this.revisions.createStagedRevision({
      manifest: body.manifest as Record<string, unknown>,
      reason: stringValue(body.reason),
      actor_user_id: req.user?.id || null,
      activate_at: body.activate_at ? dateValue(body.activate_at, 'activate_at') || null : null,
    });
  }

  @Post('revisions/:revision/activate')
  @ApiOperation({ summary: '激活已校验 AI 配置版本' })
  async activateRevision(
    @Req() req: any,
    @Param('revision') revision: string,
    @Body() body: Record<string, unknown>,
  ) {
    const value = Number(revision);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BadRequestException('revision is invalid');
    }
    return this.revisions.activateRevision(value, req.user?.id || null, stringValue((body || {}).reason));
  }

  @Post('revisions/:revision/validate')
  @ApiOperation({ summary: '校验待发布 AI 配置版本' })
  async validateRevision(@Param('revision') revision: string) {
    const value = Number(revision);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BadRequestException('revision is invalid');
    }
    return this.revisions.validateRevision(value);
  }

  @Post('execution-plan/preview')
  @ApiOperation({ summary: '预览指定产品的执行计划' })
  async previewExecutionPlan(@Body() body: Record<string, unknown>) {
    if (!body.app_id || !body.model_key) {
      throw new BadRequestException('app_id and model_key are required');
    }
    return this.plans.resolve({
      app_id: String(body.app_id),
      model_key: String(body.model_key),
      capability: stringValue(body.capability) || undefined,
      payload: body.payload && typeof body.payload === 'object'
        ? body.payload as Record<string, unknown>
        : {},
      mode: 'shadow',
    });
  }

  @Get('decoupling/mode')
  @ApiOperation({ summary: '查询当前产品/上游解耦模式' })
  async getDecouplingMode(@Query('app_id') appId?: string) {
    return {
      mode: await this.revisions.resolveMode(appId || null),
      env: stringValue(process.env.AI_PRODUCT_UPSTREAM_DECOUPLING_MODE),
    };
  }
}
