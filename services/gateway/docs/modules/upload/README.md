# Upload 模块文档

> 模块名称：`upload`
> 最后更新：2026-07-22

## 1. 模块定位
- 负责 `upload` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/upload/upload.controller.ts`
- `src/modules/upload/upload.module.ts`
- `src/modules/upload/upload.service.ts`

## 3. Controller 与路由
### UploadController
- 控制器文件：`src/modules/upload/upload.controller.ts`
- 基础路由：`tenantControllerPaths('upload', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| POST | `presigned-url` | `getPresignedUrl()` |
| POST | `audio` | `FileInterceptor()` |
| POST | `image` | `FileInterceptor()` |
| POST | `image-buffer` | `FileInterceptor()` |
| POST | `file-buffer` | `FileInterceptor()` |
| POST | `file` | `FileInterceptor()` |

所有上传路由的租户都由 URL 中的 app 与认证主体共同决定。客户端不得提交
`app_id`、`app_slug`、`key_prefix` 或对应 camelCase 字段；这些字段会被明确拒绝，
避免上传对象越过租户边界。`image-buffer` 和 `file-buffer` 仅作为旧客户端兼容路由，
服务端实现同样使用临时文件流式中转，不会把完整文件保存在 Node.js 堆内存中。

## 4. Service 能力
### UploadService
- 服务文件：`src/modules/upload/upload.service.ts`
- 核心方法：
- `deleteByFileUrl()`
- `getManagedFileKey()`
- `isManagedFileReference()`
- `resolveReadableUrl()`
- `uploadLocalFile()`
- `uploadLocalFileToKey()`
- `uploadStreamToKey()`
- `buildCdnReadableUrl()`
- `uploadAudio()`
- `uploadImage()`
- `uploadFile()`
- `buildFileUrl()`
- `resolveAppId()`
- `buildObjectKey()`
- `extractSafeExtension()`
- `extractSafeBasename()`
- `normalizeKeyPrefix()`
- `buildUploadUrl()`
- `normalizeEndpoint()`
- `extractManagedFileKey()`
- `isLikelyManagedObjectKey()`
- `buildOssClient()`
- `buildS3Client()`
- `refreshStorageProviderConfig()`
- `persistLocalFile()`
- `persistLocalFileFromPath()`
- `persistLocalStream()`

## 5. 数据库/存储依赖（自动扫描）
- （未检测到显式 SQL 表名，可能使用 Prisma ORM 查询）

## 6. 模块依赖（自动扫描）
- `api-keys`
- `auth`
- `developer-sdk`
- `runtime-settings`

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-07-22：上传租户作用域改为服务端所有；中转上传改用系统临时文件和 OSS/S3/本地流式持久化，并保证成功或失败后清理临时文件。
- 2026-06-20：自动生成/刷新模块文档结构与清单。
