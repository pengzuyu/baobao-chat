/**
 * 一级路由占位页（阶段一仅落 IM；其余模块路由已按 D01 §4.2 预留）。
 * 统一形态：模块图标 + 标题 + 设计文档指引 + 返回消息 CTA。
 */

import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '../shared/ui/Button';

interface PlaceholderPageProps {
  title: string;
  designDoc: string;
  icon: LucideIcon;
  /** 一句话模块定位（来自概要/详设），帮助走查时理解入口用途 */
  blurb: string;
}

export function PlaceholderPage({ title, designDoc, icon: Icon, blurb }: PlaceholderPageProps) {
  const navigate = useNavigate();
  return (
    <div className="state-view placeholder-page">
      <div className="state-view__inner">
        <div className="placeholder-page__icon" aria-hidden>
          <Icon size={30} strokeWidth={1.5} />
        </div>
        <div className="placeholder-page__title">{title}</div>
        <div className="state-view__text">{blurb}</div>
        <div className="placeholder-page__doc">规划详见 {designDoc}，将在后续阶段实现</div>
        <div className="state-view__action">
          <Button variant="secondary" onClick={() => navigate('/im')}>
            <ArrowLeft size={14} /> 返回消息
          </Button>
        </div>
      </div>
    </div>
  );
}
