import { app } from 'electron';
import type { ActionResult } from '../../shared/types';
import { logger } from '../logger';
import { IS_WINDOWS } from '../platform/shell';

export function setAutoStartEnabled(enabled: boolean): ActionResult {
  if (!IS_WINDOWS) {
    return {
      ok: true,
      message: '已保存开机自启偏好（将在 Windows 环境下自动注册登录启动项）',
    };
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: ['--autostart'],
    });
    logger.info('clientA', `已${enabled ? '开启' : '关闭'} Windows 开机自启`);
    return {
      ok: true,
      message: enabled ? '已开启 Windows 开机自启' : '已关闭 Windows 开机自启',
    };
  } catch (err) {
    const msg = `设置开机自启失败: ${(err as Error).message}`;
    logger.error('clientA', msg);
    return { ok: false, message: msg };
  }
}
