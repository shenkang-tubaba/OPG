import { Injectable, Logger, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';

export type MemberTier = 'NONE' | 'VIP' | 'SVIP';

export interface MallResourceRow {
  id: string;
  app_id: string;
  title: string;
  category: string;
  summary: string;
  content_html: string;
  cover_url: string;
  required_tier: string; // VIP=普通资料 | SVIP=高级资料
  tags: string[]; // 资料标签（股票讲座/基金/量学云讲堂/...）
  download_url: string | null;
  download_pwd: string | null;
  platform: string | null;
  link_status: string; // unknown | ok | suspect | invalid
  link_checked_at: Date | null;
  link_fail_count: number;
  download_count: number;
  sort_order: number;
  published: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * 寻龙诀商城资源库服务
 * - 资源 CRUD（平台管理端）
 * - 按会员档位（VIP/SVIP）过滤的资源列表（download_url 按档位剔除）
 */
@Injectable()
export class MallResourcesService implements OnModuleInit {
  private readonly logger = new Logger(MallResourcesService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`mall resources schema warmup failed: ${error?.message || error}`);
    }
  }

  /** 建表（幂等） */
  async ensureSchema() {
    if (this.schemaReady) return;
    if (!this.schemaPromise) {
      this.schemaPromise = (async () => {
        await this.prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS mall_resources (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            app_id uuid NOT NULL,
            title varchar(200) NOT NULL,
            category varchar(64) NOT NULL DEFAULT 'other',
            summary varchar(500) NOT NULL DEFAULT '',
            content_html text NOT NULL DEFAULT '',
            cover_url text NOT NULL DEFAULT '',
            required_tier varchar(16) NOT NULL DEFAULT 'VIP',
            download_url text NULL,
            download_pwd varchar(64) NULL,
            platform varchar(32) NULL,
            link_status varchar(16) NOT NULL DEFAULT 'unknown',
            link_checked_at timestamptz NULL,
            link_fail_count int NOT NULL DEFAULT 0,
            sort_order int NOT NULL DEFAULT 0,
            published boolean NOT NULL DEFAULT true,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `);
        await this.prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS idx_mall_resources_app ON mall_resources(app_id, published, sort_order)`,
        );
        // 旧表升级：追加 tags 列（text[]，默认空数组）
        await this.prisma.$executeRawUnsafe(
          `ALTER TABLE mall_resources ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'`,
        );
        // 下载量统计列（用户点"复制链接/打开网盘"时 +1）
        await this.prisma.$executeRawUnsafe(
          `ALTER TABLE mall_resources ADD COLUMN IF NOT EXISTS download_count int NOT NULL DEFAULT 0`,
        );
        // 标签管理表（增删改，按 app 隔离）
        await this.prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS mall_tags (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            app_id uuid NOT NULL,
            name varchar(64) NOT NULL,
            sort_order int NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(app_id, name)
          )
        `);
        this.schemaReady = true;
      })().catch((e) => {
        this.schemaPromise = null;
        throw e;
      });
    }
    return this.schemaPromise;
  }

  /** 由 app slug 解析 app id */
  async resolveAppId(appSlug: string): Promise<string> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM apps WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
      appSlug,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) throw new NotFoundException(`app ${appSlug} 不存在`);
    return rows[0].id;
  }

  /**
   * 判定用户会员档位
   * SVIP：scope='svip_membership' 有效；VIP：scope='app_membership'（现有 VIP 商品）或 'vip_membership' 有效
   */
  async resolveMemberTier(appId: string, userId: string): Promise<MemberTier> {
    const nowIso = new Date().toISOString();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT scope FROM user_entitlements
       WHERE app_id = $1::uuid AND user_id = $2::uuid AND is_active = true
         AND (expires_at IS NULL OR expires_at > $3::timestamptz)
         AND scope IN ('svip_membership', 'vip_membership', 'app_membership')`,
      appId,
      userId,
      nowIso,
    ) as Promise<Array<{ scope: string }>>);
    const scopes = new Set(rows.map((r) => r.scope));
    if (scopes.has('svip_membership')) return 'SVIP';
    if (scopes.has('vip_membership') || scopes.has('app_membership')) return 'VIP';
    return 'NONE';
  }

  /**
   * 权益模型（2026-10 最终版）：
   * - required_tier 为资料级别标签：VIP=普通资料，SVIP=高级资料
   * - 所有人（含游客）可预览全部资源的图文介绍
   * - 下载：普通资料 → VIP 或 SVIP 均可；高级资料 → 仅 SVIP
   */
  private canDownloadRow(row: MallResourceRow, tier: MemberTier): boolean {
    if (String(row.required_tier).toUpperCase() === 'SVIP') return tier === 'SVIP';
    return tier !== 'NONE'; // 普通资料：任意付费会员
  }

  /** 序列化：canDownload 由资料级别 × 用户档位决定 */
  private serialize(row: MallResourceRow, tier: MemberTier, withLink: boolean) {
    const base: Record<string, unknown> = {
      id: row.id,
      title: row.title,
      category: row.category,
      summary: row.summary,
      content_html: row.content_html,
      cover_url: row.cover_url,
      required_tier: row.required_tier,
      tags: row.tags || [],
      platform: row.platform,
      published: row.published,
      sort_order: row.sort_order,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (withLink) {
      base.download_url = row.download_url;
      base.download_pwd = row.download_pwd;
      base.link_status = row.link_status;
      base.link_checked_at = row.link_checked_at;
      base.link_fail_count = row.link_fail_count;
    } else {
      // 权限不足：不带链接字段（物理不返回，防抓包）
      base.download_url = null;
      base.download_pwd = null;
      base.link_locked = true;
    }
    base.download_count = row.download_count || 0; // 排名展示用，所有身份可见
    return base;
  }

  /**
   * 用户端资源列表：所有人可预览；下载按资料级别控制（普通=VIP+，高级=SVIP）
   */
  async listForUser(appSlug: string, userId: string, category?: string, tag?: string, keyword?: string, sort?: string) {
    await this.ensureSchema();
    const appId = await this.resolveAppId(appSlug);
    const tier = await this.resolveMemberTier(appId, userId);

    // 排序白名单：download_count=下载量（默认）、time=最新、title=名称
    const orderSql =
      sort === 'time' ? 'created_at DESC' :
      sort === 'title' ? `title COLLATE "zh-CN" ASC` :
      'download_count DESC, sort_order DESC, created_at DESC';

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM mall_resources
       WHERE app_id = $1::uuid AND published = true
         AND ($2::text = '' OR category = $2::text)
         AND ($3::text = '' OR $3::text = ANY(tags))
         AND ($4::text = '' OR title ILIKE '%' || $4::text || '%' OR summary ILIKE '%' || $4::text || '%')
       ORDER BY ${orderSql}
       LIMIT 500`,
      appId, category || '', tag || '', keyword || '',
    ) as Promise<MallResourceRow[]>);

    const items = rows.map((r) => this.serialize(r, tier, this.canDownloadRow(r, tier)));
    const canDownload = rows.some((r) => this.canDownloadRow(r, tier));

    return { tier, can_download: canDownload, total: items.length, items };
  }

  /** 获取单资源（用户端）：预览开放，下载按资料级别控制 */
  async getForUser(appSlug: string, userId: string, resourceId: string) {
    await this.ensureSchema();
    const appId = await this.resolveAppId(appSlug);
    const tier = await this.resolveMemberTier(appId, userId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM mall_resources WHERE id = $1::uuid AND app_id = $2::uuid AND published = true LIMIT 1`,
      resourceId,
      appId,
    ) as Promise<MallResourceRow[]>);
    const row = rows[0];
    if (!row) throw new NotFoundException('资源不存在');
    return this.serialize(row, tier, this.canDownloadRow(row, tier));
  }

  // ===== 平台管理端 CRUD =====

  async adminList(appId: string, query: Record<string, unknown>) {
    await this.ensureSchema();
    const category = query.category ? String(query.category) : null;
    const rows = await (category
      ? this.prisma.$queryRawUnsafe(
          `SELECT * FROM mall_resources WHERE app_id = $1::uuid AND category = $2 ORDER BY sort_order DESC, created_at DESC LIMIT 500`,
          appId,
          category,
        )
      : this.prisma.$queryRawUnsafe(
          `SELECT * FROM mall_resources WHERE app_id = $1::uuid ORDER BY sort_order DESC, created_at DESC LIMIT 500`,
          appId,
        )) as MallResourceRow[];
    return { total: rows.length, items: rows.map((r) => this.serialize(r, 'SVIP', true)) };
  }

  async adminUpsert(appId: string, body: Record<string, unknown>, resourceId?: string) {
    await this.ensureSchema();
    const title = String(body.title || '').trim();
    if (!title) throw new BadRequestException('title 不能为空');
    const requiredTier = ['VIP', 'SVIP'].includes(String(body.required_tier)) ? String(body.required_tier) : 'VIP';
    const platform = this.detectPlatform(String(body.download_url || ''));
    // 标签：支持数组或逗号/中文逗号分隔字符串；去重、去空白、截断到 16 个、单标签 ≤32 字
    const rawTags = Array.isArray(body.tags)
      ? body.tags.map((t) => String(t))
      : String(body.tags || '').split(/[,，、\s]+/);
    const tags = Array.from(new Set(rawTags.map((t) => t.trim()).filter(Boolean)))
      .slice(0, 16)
      .map((t) => t.slice(0, 32));
    const payload = {
      title,
      category: String(body.category || 'other').slice(0, 64),
      summary: String(body.summary || '').slice(0, 500),
      content_html: String(body.content_html || ''),
      cover_url: String(body.cover_url || ''),
      required_tier: requiredTier,
      tags,
      download_url: body.download_url ? String(body.download_url) : null,
      download_pwd: body.download_pwd ? String(body.download_pwd).slice(0, 64) : null,
      platform,
    };

    if (resourceId) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE mall_resources SET
           title=$1, category=$2, summary=$3, content_html=$4, cover_url=$5,
           required_tier=$6, download_url=$7, download_pwd=$8, platform=$9, tags=$12::text[],
           link_status=CASE WHEN $7::text IS DISTINCT FROM download_url THEN 'unknown' ELSE link_status END,
           link_fail_count=CASE WHEN $7::text IS DISTINCT FROM download_url THEN 0 ELSE link_fail_count END,
           updated_at=now()
         WHERE id=$10::uuid AND app_id=$11::uuid`,
        payload.title, payload.category, payload.summary, payload.content_html, payload.cover_url,
        payload.required_tier, payload.download_url, payload.download_pwd, payload.platform,
        resourceId, appId, payload.tags,
      );
      return { id: resourceId, ...payload };
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO mall_resources (
         id, app_id, title, category, summary, content_html, cover_url,
         required_tier, download_url, download_pwd, platform, tags, sort_order, published
       ) VALUES (
         gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12, $13
       ) RETURNING id`,
      appId, payload.title, payload.category, payload.summary, payload.content_html, payload.cover_url,
      payload.required_tier, payload.download_url, payload.download_pwd, payload.platform, payload.tags,
      Number(body.sort_order) || 0, body.published === undefined ? true : !!body.published,
    ) as Promise<Array<{ id: string }>>);
    return { id: rows[0].id, ...payload };
  }

  // ===== 标签管理（mall_tags CRUD） =====

  /** 标签列表（含每个标签被引用的次数） */
  async adminListTags(appId: string) {
    await this.ensureSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT t.id, t.name, t.sort_order,
              (SELECT COUNT(*) FROM mall_resources r WHERE r.app_id = t.app_id AND t.name = ANY(r.tags))::int AS usage_count
       FROM mall_tags t WHERE t.app_id = $1::uuid
       ORDER BY t.sort_order DESC, t.created_at ASC`,
      appId,
    ) as Promise<Array<{ id: string; name: string; sort_order: number; usage_count: number }>>);
    return { total: rows.length, items: rows };
  }

  async adminCreateTag(appId: string, body: Record<string, unknown>) {
    await this.ensureSchema();
    const name = String(body.name || '').trim().slice(0, 64);
    if (!name) throw new BadRequestException('标签名不能为空');
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO mall_tags (app_id, name, sort_order) VALUES ($1::uuid, $2, $3)
       ON CONFLICT (app_id, name) DO UPDATE SET sort_order = EXCLUDED.sort_order
       RETURNING id, name, sort_order`,
      appId, name, Number(body.sort_order) || 0,
    ) as Promise<Array<{ id: string; name: string; sort_order: number }>>);
    return rows[0];
  }

  async adminUpdateTag(appId: string, tagId: string, body: Record<string, unknown>) {
    await this.ensureSchema();
    const name = String(body.name || '').trim().slice(0, 64);
    if (!name) throw new BadRequestException('标签名不能为空');
    // 同步更新资源行内嵌的 tags 数组（改名联动）
    const old = await (this.prisma.$queryRawUnsafe(
      `SELECT name FROM mall_tags WHERE id = $1::uuid AND app_id = $2::uuid LIMIT 1`,
      tagId, appId,
    ) as Promise<Array<{ name: string }>>);
    const oldName = old[0]?.name;
    await this.prisma.$executeRawUnsafe(
      `UPDATE mall_tags SET name = $3, sort_order = COALESCE($4::int, sort_order) WHERE id = $1::uuid AND app_id = $2::uuid`,
      tagId, appId, name, Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : null,
    );
    if (oldName && oldName !== name) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE mall_resources SET tags = array_replace(tags, $3, $4), updated_at = now() WHERE app_id = $1::uuid AND $3 = ANY(tags)`,
        appId, appId, oldName, name,
      );
    }
    return { id: tagId, name };
  }

  async adminDeleteTag(appId: string, tagId: string) {
    await this.ensureSchema();
    const old = await (this.prisma.$queryRawUnsafe(
      `SELECT name FROM mall_tags WHERE id = $1::uuid AND app_id = $2::uuid LIMIT 1`,
      tagId, appId,
    ) as Promise<Array<{ name: string }>>);
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM mall_tags WHERE id = $1::uuid AND app_id = $2::uuid`,
      tagId, appId,
    );
    const oldName = old[0]?.name;
    if (oldName) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE mall_resources SET tags = array_remove(tags, $3), updated_at = now() WHERE app_id = $1::uuid AND $3 = ANY(tags)`,
        appId, appId, oldName,
      );
    }
    return { deleted: true };
  }

  async adminDelete(appId: string, resourceId: string) {
    await this.ensureSchema();
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM mall_resources WHERE id = $1::uuid AND app_id = $2::uuid`,
      resourceId, appId,
    );
    return { deleted: true };
  }

  /** 更新链接状态（巡检 worker 调用） */
  async updateLinkStatus(resourceId: string, status: string, failCount: number) {
    await this.ensureSchema();
    await this.prisma.$executeRawUnsafe(
      `UPDATE mall_resources SET link_status=$1, link_fail_count=$2, link_checked_at=now(), updated_at=now()
       WHERE id=$3::uuid`,
      status, failCount, resourceId,
    );
  }

  /** 下载量 +1（用户点复制/打开时上报；游客也可） */
  async trackDownload(appSlug: string, resourceId: string) {
    await this.ensureSchema();
    const appId = await this.resolveAppId(appSlug);
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE mall_resources SET download_count = download_count + 1, updated_at = now()
       WHERE id = $1::uuid AND app_id = $2::uuid
       RETURNING download_count`,
      resourceId, appId,
    ) as Promise<Array<{ download_count: number }>>);
    if (!rows[0]) throw new NotFoundException('资源不存在');
    return { download_count: rows[0].download_count };
  }

  /** 全部待巡检资源 */
  async listAllWithLink(appId?: string) {
    await this.ensureSchema();
    const rows = appId
      ? await (this.prisma.$queryRawUnsafe(
          `SELECT * FROM mall_resources WHERE download_url IS NOT NULL AND download_url <> '' AND app_id=$1::uuid`,
          appId,
        ) as Promise<MallResourceRow[]>)
      : await (this.prisma.$queryRawUnsafe(
          `SELECT * FROM mall_resources WHERE download_url IS NOT NULL AND download_url <> ''`,
        ) as Promise<MallResourceRow[]>);
    return rows;
  }

  /** 平台 id（用于告警） */
  async resolveAppIdBySlugOrNull(appSlug: string): Promise<string | null> {
    try {
      return await this.resolveAppId(appSlug);
    } catch {
      return null;
    }
  }

  /** 由 URL 识别网盘平台 */
  detectPlatform(url: string): string | null {
    const u = (url || '').toLowerCase();
    if (!u) return null;
    if (u.includes('pan.baidu.com')) return 'baidu';
    if (u.includes('lanzou')) return 'lanzou';
    if (u.includes('pan.quark.cn')) return 'quark';
    if (u.includes('aliyundrive.com') || u.includes('alipan.com')) return 'aliyun';
    if (u.includes('cloud.189.cn')) return 'tianyi';
    return 'other';
  }
}
