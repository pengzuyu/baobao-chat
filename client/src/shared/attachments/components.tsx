/**
 * 附件展示组件（2026-11-26）：
 * - AttachmentStrip：输入框上方待发区（图片 64px 缩略卡 + 文件名卡 + 删除）；
 * - AttachmentList：气泡内附件段（1 张大图 max 240 / 多张 96 网格，antd Image
 *   点击预览；文件卡点击 Finder 定位；asset 加载失败降级文件名卡）。
 *
 * 图片渲染走 convertFileSrc（asset://；壳侧授权）——纯浏览器 dev 无协议，
 * img onError 降级为文件名卡。
 */

import { memo } from 'react';
import { Flex, Image as AntImage, Typography, theme } from 'antd';
import { FileText, X } from 'lucide-react';
import type { AttachmentMeta } from './index';
import { assetUrl, formatSize, revealPath } from './index';

/** 待发区条目（比 meta 多可选的本地预览 objectURL——粘贴场景用） */
export interface StripItem extends AttachmentMeta {
  /** 粘贴图预览（blob objectURL；本机路径项走 assetUrl） */
  previewUrl?: string;
}

/** 输入框上方待发区 */
export const AttachmentStrip = memo(function AttachmentStrip({
  items,
  onRemove,
}: {
  items: StripItem[];
  onRemove: (path: string) => void;
}) {
  const { token } = theme.useToken();
  if (items.length === 0) return null;
  return (
    <Flex gap={8} wrap style={{ marginBottom: 8 }}>
      {items.map((it) => (
        <div
          key={it.path}
          style={{
            position: 'relative',
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 8,
            padding: it.kind === 'image' ? 4 : '6px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: token.colorBgLayout,
            maxWidth: 200,
          }}
        >
          {it.kind === 'image' ? (
            <img
              src={it.previewUrl ?? assetUrl(it.path)}
              alt={it.name}
              style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 4, display: 'block' }}
            />
          ) : (
            <>
              <FileText size={16} style={{ color: token.colorPrimary, flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <Typography.Text ellipsis style={{ fontSize: 12, maxWidth: 130, display: 'block' }}>
                  {it.name}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {formatSize(it.size)}
                </Typography.Text>
              </div>
            </>
          )}
          <button
            type="button"
            aria-label={`移除附件 ${it.name}`}
            onClick={() => onRemove(it.path)}
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              width: 18,
              height: 18,
              borderRadius: 999,
              border: 'none',
              background: token.colorTextTertiary,
              color: token.colorBgContainer,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </Flex>
  );
});

/** 气泡内附件段（发送当下与历史回放同构：只有 path/name/kind/size） */
export const AttachmentList = memo(function AttachmentList({
  attachments,
}: {
  attachments: AttachmentMeta[];
}) {
  const { token } = theme.useToken();
  if (attachments.length === 0) return null;
  const images = attachments.filter((a) => a.kind === 'image');
  const files = attachments.filter((a) => a.kind !== 'image');

  const renderImage = (a: AttachmentMeta, height: number) => (
    <AntImage
      key={a.path}
      src={assetUrl(a.path)}
      alt={a.name}
      width={height * 1.5}
      height={height}
      style={{ objectFit: 'cover', borderRadius: 8, display: 'block', background: token.colorBgLayout }}
      preview={{
        mask: <Typography.Text style={{ fontSize: 11 }}>{a.name}</Typography.Text>,
      }}
    />
  );

  return (
    <Flex vertical gap={6} style={{ marginBottom: 4 }}>
      {images.length > 0 ? (
        <Flex gap={6} wrap>
          {images.length === 1 ? (
            renderImage(images[0], 160)
          ) : (
            images.map((a) => renderImage(a, 96))
          )}
        </Flex>
      ) : null}
      {files.map((a) => (
        <button
          key={a.path}
          type="button"
          onClick={() => void revealPath(a.path)}
          title="点击在 Finder 中定位"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 10px',
            borderRadius: 8,
            border: `1px solid ${token.colorBorderSecondary}`,
            background: 'rgba(255,255,255,0.14)',
            color: 'inherit',
            cursor: 'pointer',
            font: 'inherit',
            maxWidth: 280,
            minWidth: 0,
          }}
        >
          <FileText size={14} style={{ flexShrink: 0 }} />
          <Typography.Text ellipsis style={{ fontSize: 12, color: 'inherit', flex: 1 }}>
            {a.name}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {formatSize(a.size)}
          </Typography.Text>
        </button>
      ))}
    </Flex>
  );
});
