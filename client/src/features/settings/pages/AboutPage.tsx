/**
 * 设置 · 关于（D01 §4.2）：版本、技术栈与设计文档索引。
 * 版本号取 package.json（与 tauri.conf.json version 保持同步）。
 */

import pkg from '../../../../package.json';
import { Logo } from '../../../shared/ui/Logo';

export function AboutPage() {
  return (
    <div className="settings-section">
      <h2 className="settings-section__title">关于</h2>

      <div className="about-card">
        <div className="about-card__brand">
          <Logo size={52} />
          <div className="about-card__name">BaobaoWork</div>
          <div className="about-card__slogan">让协作更简单 · 企业协作工作台</div>
          <span className="about-card__version">v{pkg.version}</span>
        </div>

        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__name">客户端技术栈</div>
            </div>
            <span className="settings-row__value">Tauri 2 · React 18 · antd 5 · Vite</span>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__name">设计系统</div>
            </div>
            <span className="settings-row__value">D01 令牌体系 · 亮/暗双主题</span>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__name">设计文档</div>
              <div className="settings-row__desc">概要 19 篇 + 详设 14 篇（docs/；doc/bot/rtc/meeting 篇目已随瘦身移除）</div>
            </div>
          </div>
        </div>

        <div className="about-card__license">基础件使用成熟开源软件（MIT/Apache-2.0），业务代码完全自研（附录 A 许可清单）</div>
      </div>
    </div>
  );
}
