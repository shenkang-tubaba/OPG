import { Module } from '@nestjs/common';
import { MallResourcesController } from './mall-resources.controller';
import { MallResourcesPlatformController } from './mall-resources-platform.controller';
import { MallResourcesService } from './mall-resources.service';
import { LinkCheckWorkerService } from './link-check.worker.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AdminNotificationsModule } from '../admin-notifications/admin-notifications.module';

@Module({
  imports: [AdminNotificationsModule],
  controllers: [MallResourcesController, MallResourcesPlatformController],
  providers: [MallResourcesService, LinkCheckWorkerService, JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard],
  exports: [MallResourcesService],
})
export class MallResourcesModule {}
