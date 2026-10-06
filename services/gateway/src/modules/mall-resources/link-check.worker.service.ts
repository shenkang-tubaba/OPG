import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MallResourcesService, MallResourceRow } from './mall-resources.service';
import { AdminNotificationsService } from '../admin-notifications/admin-notifications.service';

/** 失效页特征关键词（按平台） */
const INVALID_KEYWORDS: Record<string, string[]> = {
  baidu: ['不存在', '已删除', '已失效', '分享的文件已经被取消', '你访问的页面不存在', '链接不存在', '违规', '惹上了版权'],
  lanzou: ['文件取消分享了', '文件不存在', '文件已经删除', '页面不存在'],
  quark: ['分享已取消', '链接失效', '文件已删除', '分享不存在'],
  aliyun: ['分享不存在', '链接失效', '已取消分享', '分享已过期'],
  tianyi: ['链接已失效', '文件已删除', '分享已取消'],
  other: ['404', 'not found', '不存在', '已失效'],
};

/** 连续失败多少次判失效 */
const FAIL_THRESHOLD = 3;
/** 单链接请求超时 ms */
const FETCH_TIMEOUT = 12000;

@Injectable()
export class LinkCheckWorkerService {
  private readonly logger = new Logger(LinkCheckWorkerService.name);
  private running = false;

  constructor(
    private readonly resources: MallResourcesService,
    private readonly notifications: AdminNotificationsService,
  ) {}

  /** 每天凌晨 3:30 全量巡检 */
  @Cron('0 30 3 * * *', { timeZone: 'Asia/Shanghai' })
  async cronCheck() {
    this.logger.log('mall link check cron start');
    try {
      await this.checkAll(undefined);
    } catch (e: any) {
      this.logger.warn(`mall link check cron failed: ${e?.message || e}`);
    }
  }

  /**
   * 全量巡检（可限定 app）
   * 判定规则：HTTP GET 分享页 → 含失效关键词 = 本次失败；连续 FAIL_THRESHOLD 次失败标记 invalid；
   * 一次成功即清零并标记 ok。失效/恢复都会 emit 管理端通知。
   */
  async checkAll(appId?: string) {
    if (this.running) return { skipped: true, reason: 'already running' };
    this.running = true;
    const startedAt = Date.now();
    try {
      const rows = await this.resources.listAllWithLink(appId);
      const results: Array<{ id: string; title: string; status: string; failCount: number; reason?: string }> = [];
      let invalidCount = 0;
      let recoveredCount = 0;

      for (const row of rows) {
        try {
          const check = await this.checkLink(row);
          let nextStatus: string;
          let nextFail = row.link_fail_count;
          const wasInvalid = row.link_status === 'invalid';

          if (check.ok) {
            nextStatus = 'ok';
            nextFail = 0;
            if (wasInvalid) {
              recoveredCount += 1;
              await this.emitAlert(row, '资源链接恢复', `「${row.title}」的分享链接已恢复正常。`, 'info', 'recovered');
            }
          } else {
            nextFail = (row.link_fail_count || 0) + 1;
            nextStatus = nextFail >= FAIL_THRESHOLD ? 'invalid' : 'suspect';
            if (nextStatus === 'invalid' && !wasInvalid) {
              invalidCount += 1;
              await this.emitAlert(
                row,
                '资源链接失效',
                `「${row.title}」的分享链接已连续 ${nextFail} 次检测失败（${check.reason || '未知原因'}），请尽快更新。平台：${row.platform || '未知'}`,
                'high',
                'invalid',
              );
            }
          }
          await this.resources.updateLinkStatus(row.id, nextStatus, nextFail);
          results.push({ id: row.id, title: row.title, status: nextStatus, failCount: nextFail, reason: check.reason || undefined });
        } catch (e: any) {
          this.logger.warn(`check link ${row.id} error: ${e?.message || e}`);
          results.push({ id: row.id, title: row.title, status: row.link_status, failCount: row.link_fail_count, reason: 'check error' });
        }
      }

      const summary = {
        total: rows.length,
        invalid: invalidCount,
        recovered: recoveredCount,
        duration_ms: Date.now() - startedAt,
        results,
      };
      this.logger.log(`mall link check done: ${JSON.stringify({ total: summary.total, invalid: summary.invalid, recovered: summary.recovered })}`);
      return summary;
    } finally {
      this.running = false;
    }
  }

  /** 单链接检测：GET 分享页文本，匹配失效关键词 */
  private async checkLink(row: MallResourceRow): Promise<{ ok: boolean; reason?: string }> {
    const url = row.download_url || '';
    const platform = row.platform || this.resources.detectPlatform(url) || 'other';
    const keywords = INVALID_KEYWORDS[platform] || INVALID_KEYWORDS.other;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          // 模拟浏览器，降低被网盘风控概率
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });
      const text = (await res.text().catch(() => '')).slice(0, 200000);
      if (res.status === 404) return { ok: false, reason: `HTTP 404` };
      if (res.status >= 500) return { ok: false, reason: `HTTP ${res.status}` };
      const bodyText = text.replace(/<[^>]+>/g, ' '); // 去标签粗提取
      const hit = keywords.find((k) => bodyText.includes(k));
      if (hit) return { ok: false, reason: `命中失效关键词「${hit}」` };
      return { ok: true };
    } catch (e: any) {
      // 网络错误/超时按失败计（但区分原因）
      return { ok: false, reason: e?.name === 'AbortError' ? '请求超时' : `网络错误: ${e?.message || 'unknown'}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 管理端告警（进 admin-notifications 消息中心，可配飞书/邮件渠道） */
  private async emitAlert(row: MallResourceRow, title: string, message: string, severity: string, kind: string) {
    try {
      await this.notifications.emit({
        app_id: row.app_id,
        event_type: `mall.link.${kind}`,
        severity: severity as any,
        title,
        message,
        source_module: 'mall-resources',
        source_id: row.id,
        payload: { resource_id: row.id, title: row.title, platform: row.platform, url: row.download_url },
        dedupe_key: `mall-link-${kind}-${row.id}`,
      });
    } catch (e: any) {
      this.logger.warn(`mall link alert emit failed: ${e?.message || e}`);
    }
  }
}
