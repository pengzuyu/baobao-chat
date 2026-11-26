/**
 * 部署期公开配置（2026-11-26 邮箱后缀部署侧单源化）：
 * 唯一权威源=服务端 BBC_MAIL_DOMAIN（helm config.mailDomain / compose .env），
 * 编译期不再烘死任何值（原 brand.json mail_domain 字段已退役）。部署期定值、
 * 启动后恒定的只读快照——非运行时可切换，客户端无修改入口。
 * 端点 GET /api/v1/config/public 预登录可读（注册页提示所需，同 /setup/status 口径）。
 */

import { useEffect, useState } from 'react';
import { http } from './api/http';

let cached: Promise<string> | null = null;

/** 邮箱统一后缀（模块级 Promise 缓存，多组件共享同一次请求；失败回落空串=文案降级） */
export function fetchMailDomain(): Promise<string> {
  if (!cached) {
    cached = http
      .get<{ mail_domain?: string }>('/config/public')
      .then((d) => d.mail_domain ?? '')
      .catch(() => '');
  }
  return cached;
}

/** React 钩子：挂载时取一次；返回前为空串（展示层按空降级为通用文案） */
export function useMailDomain(): string {
  const [domain, setDomain] = useState('');
  useEffect(() => {
    let alive = true;
    void fetchMailDomain().then((d) => {
      if (alive) setDomain(d);
    });
    return () => {
      alive = false;
    };
  }, []);
  return domain;
}
