import { IoAdapter } from '@nestjs/platform-socket.io';
import { createCorsOriginCallback } from './cors-origin-policy';
import { createWebSocketRequestGuard } from './websocket-security-policy';

export class SecureSocketIoAdapter extends IoAdapter {
  constructor(
    app: any,
    private readonly configuredOrigins: readonly string[],
    private readonly allowDevelopmentOrigins: boolean,
    private readonly maxHttpBufferSize: number,
  ) {
    super(app);
  }

  createIOServer(port: number, options: Record<string, any> = {}): any {
    const originGuard = createWebSocketRequestGuard(
      this.configuredOrigins,
      this.allowDevelopmentOrigins,
    );
    const configuredAllowRequest = options.allowRequest;
    return super.createIOServer(port, {
      ...options,
      maxHttpBufferSize: this.maxHttpBufferSize,
      cors: {
        ...(options.cors || {}),
        origin: createCorsOriginCallback(this.configuredOrigins, this.allowDevelopmentOrigins),
        credentials: true,
      },
      allowRequest: (request: any, callback: (error: string | null, success: boolean) => void) => {
        originGuard(request, (originError, allowed) => {
          if (!allowed) {
            callback(originError || 'origin not allowed', false);
            return;
          }
          if (typeof configuredAllowRequest === 'function') {
            configuredAllowRequest(request, callback);
            return;
          }
          callback(null, true);
        });
      },
    });
  }
}
