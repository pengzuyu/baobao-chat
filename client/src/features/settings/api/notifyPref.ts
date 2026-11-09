/**
 * 通知偏好 API（0030 / D12：设置页服务端驱动存储）。
 */

import { http } from '../../../shared/api/http';

export interface NotifyPref {
  msg_notify: boolean;
  mention_notify: boolean;
  dnd_range: 'off' | 'work-night' | 'all-day';
}

export async function fetchNotifyPref(): Promise<NotifyPref> {
  return http.get<NotifyPref>('/me/notify-pref');
}

export async function patchNotifyPref(p: NotifyPref): Promise<NotifyPref> {
  return http.patch<NotifyPref>('/me/notify-pref', p);
}
