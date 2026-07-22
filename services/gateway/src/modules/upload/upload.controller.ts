import { BadRequestException, Body, Controller, Param, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { DeveloperAuthorizationService } from '../developer-sdk/developer-authorization.service';
import { DeveloperSdkAuthGuard } from '../developer-sdk/developer-sdk-auth.guard';
import { cleanupTemporaryUpload, temporaryUploadStorage } from './temporary-upload';
import { assertNoStorageScopeOverrides, StorageScopeOverrideBody } from './upload-request.policy';
import { UploadService } from './upload.service';

@ApiTags('Upload')
@Controller(tenantControllerPaths('upload', true))
@UseGuards(DeveloperSdkAuthGuard)
@ApiBearerAuth()
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly developerAuthorizationService: DeveloperAuthorizationService,
  ) {}

  @Post('presigned-url')
  @ApiOperation({ summary: '获取预签名上传URL' })
  async getPresignedUrl(
    @Req() req: any,
    @Param('app') app: string,
    @Body()
    body: {
      filename: string;
      content_type?: string;
      contentType?: string;
    } & StorageScopeOverrideBody,
  ) {
    this.developerAuthorizationService.assertActorScope(req.user, 'upload:write');
    assertNoStorageScopeOverrides(body);
    return this.uploadService.getPresignedUrl(
      req.user.id,
      body.filename,
      body.content_type || body.contentType || 'application/octet-stream',
      app || req.user.appSlug,
    );
  }

  @Post('audio')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: temporaryUploadStorage(),
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: '上传音频文件' })
  @ApiConsumes('multipart/form-data')
  async uploadAudio(@UploadedFile() file: Express.Multer.File, @Req() req: any, @Param('app') app: string) {
    try {
      this.developerAuthorizationService.assertActorScope(req.user, 'upload:write');
      return await this.uploadService.uploadAudio(file, req.user.id, app || req.user.appSlug);
    } finally {
      await cleanupTemporaryUpload(file);
    }
  }

  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: temporaryUploadStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: '上传图片文件' })
  @ApiConsumes('multipart/form-data')
  async uploadImage(@UploadedFile() file: Express.Multer.File, @Req() req: any, @Param('app') app: string) {
    try {
      this.developerAuthorizationService.assertActorScope(req.user, 'upload:write');
      return await this.uploadService.uploadImage(file, req.user.id, app || req.user.appSlug);
    } finally {
      await cleanupTemporaryUpload(file);
    }
  }

  @Post('image-buffer')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: temporaryUploadStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: '上传图片到 OSS（服务端中转，避免浏览器直传跨域限制）' })
  @ApiConsumes('multipart/form-data')
  async uploadImageBuffer(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
    @Param('app') app: string,
    @Body()
    body: StorageScopeOverrideBody,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    try {
      this.developerAuthorizationService.assertActorScope(req.user, 'upload:write');
      assertNoStorageScopeOverrides(body);
      return await this.uploadService.uploadLocalFile(
        req.user.id,
        file.originalname,
        file.mimetype || 'application/octet-stream',
        file.path,
        app || req.user.appSlug,
        'uploads/images',
      );
    } finally {
      await cleanupTemporaryUpload(file);
    }
  }

  @Post('file-buffer')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: temporaryUploadStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: '上传任意文件到 OSS（服务端中转）' })
  @ApiConsumes('multipart/form-data')
  async uploadFileBuffer(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
    @Param('app') app: string,
    @Body()
    body: StorageScopeOverrideBody & {
      content_type?: string;
      contentType?: string;
    },
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    try {
      this.developerAuthorizationService.assertActorScope(req.user, 'upload:write');
      assertNoStorageScopeOverrides(body);
      return await this.uploadService.uploadLocalFile(
        req.user.id,
        file.originalname,
        body.content_type || body.contentType || file.mimetype || 'application/octet-stream',
        file.path,
        app || req.user.appSlug,
        'uploads/files',
      );
    } finally {
      await cleanupTemporaryUpload(file);
    }
  }

  @Post('file')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: temporaryUploadStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: '上传通用文件' })
  @ApiConsumes('multipart/form-data')
  async uploadFile(@UploadedFile() file: Express.Multer.File, @Req() req: any, @Param('app') app: string) {
    try {
      this.developerAuthorizationService.assertActorScope(req.user, 'upload:write');
      return await this.uploadService.uploadFile(file, req.user.id, app || req.user.appSlug);
    } finally {
      await cleanupTemporaryUpload(file);
    }
  }
}
