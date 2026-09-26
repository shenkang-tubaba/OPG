# AI 产品 / 上游 / 售价 / 成本解耦（P0）

从 ArtiSalesBackend 的 Product-Upstream Decoupling 移植到 OPG。默认运行模式为 `legacy`，不影响现有扣费与路由。

## 目标

把四类事实拆开：

1. 对外产品：`ai_global_models.model_key`
2. 上游执行：`ai_upstream_models` + `ai_model_source_routes.upstream_model_id`
3. 用户售价：`ai_model_sell_price_versions`
4. 上游成本：`ai_upstream_cost_versions`

原则：**售价与成本永不互相推导**。

## 运行模式

| 模式 | 行为 |
| --- | --- |
| `legacy`（默认） | 现有 `ResolvedAiRoute` 价格字段继续扣费；新表可暗写 |
| `shadow` | 旧链路继续路由与扣费；同步解析执行计划并打 compare 日志/事件 |
| `enforced` | 新链路成为真值；缺价或缺可执行候选则失败 |

配置优先级：

1. 环境变量 `AI_PRODUCT_UPSTREAM_DECOUPLING_MODE`
2. `app_settings.extra_json.ai_product_upstream_decoupling.mode`
3. 默认 `legacy`

## 关键代码

| 模块 | 路径 |
| --- | --- |
| 类型 | `services/gateway/src/modules/ai-chat/ai-product-decoupling.types.ts` |
| 请求变体 | `ai-request-variant.normalizer.ts` |
| 价本 | `ai-price-book.service.ts` |
| 执行计划 | `ai-execution-plan-resolver.service.ts` |
| 配置版本 | `ai-configuration-revision.service.ts` |
| 上游目录 | `ai-upstream-catalog.service.ts` |
| 调用接入 | `ai-chat.service.ts` → `applyDecoupledExecutionPlan` |
| 管理 API | `platform-ai-product-decoupling.controller.ts` |
| 迁移 | `prisma/migrations/20260903_110000_ai_product_upstream_decoupling/` |
| 回填 | `scripts/backfill-ai-product-upstream-decoupling.ts` |

## 上线步骤

1. 部署并执行 `prisma migrate deploy`
2. Dry-run 回填：

```bash
cd services/gateway
DATABASE_URL=... npx tsx scripts/backfill-ai-product-upstream-decoupling.ts --dry-run
```

3. 正式回填（可先 `--catalog-only` 只建上游目录并链 route）：

```bash
DATABASE_URL=... npx tsx scripts/backfill-ai-product-upstream-decoupling.ts --catalog-only
DATABASE_URL=... npx tsx scripts/backfill-ai-product-upstream-decoupling.ts
```

4. 单 App 开 shadow：在 `app_settings.extra_json` 写入：

```json
{
  "ai_product_upstream_decoupling": { "mode": "shadow" }
}
```

5. 观察 `decoupling_shadow_compare` 请求事件与 gateway 日志差异，确认一致后再考虑 `enforced`。

## 管理 API

前缀：`/api/v1/platform-admin/ai`

- `GET/POST /upstreams`、`PUT /upstreams/:id`
- `GET/POST /products/:model_id/sell-price`
- `GET/POST /upstreams/:id/cost-price`
- `GET/PUT /products/:model_id/routes`
- `GET /revisions/active`、`POST /revisions`、`POST /revisions/:n/validate|activate`
- `POST /execution-plan/preview`
- `GET /decoupling/mode`

## 会员线路与独立价格

- 模型的 `membership_route_enabled` 默认关闭。开启后，每条 `source_routes` 可设 `audience_policy.membership_access` 为 `ALL`、`FREE_ONLY` 或 `PAID_ONLY`。管理 API 与模型编辑页都会要求免费和会员各有至少一条启用线路。
- 会员身份由服务端按当前 App 的有效 `users.membership_type = PREMIUM`、未过期会员时间或有效 `ai_membership` 权益解析。请求中传入的会员等级不可信。候选在调度、黏性线路和故障切换之前过滤；所有协议共用这一候选集合。
- 异步视频任务把线路键、上游模型、售价与成本版本、会员判定存入任务 metadata。续查使用原始线路；原始线路已删除时返回不可用，不会切到其他成本线路。
- 管理页“价格”分别保存产品模型的对外售价和每条来源线路的上游成本。二者使用独立版本表和独立规则；首次保存时不会从旧价格字段推导任何金额。
- `enforced` 模式在请求前用售价版本预估积分，实际用量用售价版本结算积分、用成本版本记录上游成本。`legacy` 和 `shadow` 模式沿用旧扣费结果。需要先执行 `20260926_120000_ai_model_membership_routing` 迁移及原有解耦回填，再按本文上线步骤验证并切换模式。
- `enforced` 模式若实际用量的版本价本无法读取，会记录异常并停止旧价扣费；已建立的积分预留保持待结算，需排查价本或数据库后人工处理。
- 价格规则中的 token 与字符单价按每百万单位填写；`call`、`minute`、`second`、`image` 按各自单位填写。可用 `dimension_rates` 按请求参数配置不同图片、视频等价格。

CLI、MCP 和 SDK 检查：`packages/sdk` 已提供 `platform.ai.decoupling` 的上游、售价、成本和线路管理方法，输入为通用对象，新增会员字段可以透传。CLI/MCP 面向租户调用者，不暴露平台管理员的商业价格修改；公开调用协议和模型键没有变化，因此无需新增 CLI/MCP 工具。`docs/CLI_USAGE.md` 的调用方式保持有效。

## 明确不做（本轮）

- 会员折扣 / 团队计费账户 / 毛利报表 UI（ArtiSales 商业化专属）
- Prompt Cache Affinity（P1）
- 删除 `ai_global_models` 上的 legacy 价格字段

## CLI / SDK

- SDK：`platform.ai.decoupling.*` 已对齐管理 API
- CLI：无需变更；这是平台管理面能力，不是租户用户 CLI 能力
