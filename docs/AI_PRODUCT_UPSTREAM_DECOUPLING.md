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

## 明确不做（本轮）

- 会员折扣 / 团队计费账户 / 毛利报表 UI（ArtiSales 商业化专属）
- Prompt Cache Affinity（P1）
- 删除 `ai_global_models` 上的 legacy 价格字段

## CLI / SDK

- SDK：`platform.ai.decoupling.*` 已对齐管理 API
- CLI：无需变更；这是平台管理面能力，不是租户用户 CLI 能力
