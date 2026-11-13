/**
 * 发送前预览弹层（D06 PFL-03 阶段一+阶段二）：
 * - 图片显示本地缩略（objectURL）+ caption 附言输入（04 §1.2 第 5 类）；文件显示名/大小
 * - 视频显示本地播放预览，发送时端侧截首帧上传为 poster（04 §1.2 第 8 类 video 卡片）
 * - 发送 = 智能上传（check 秒传 → ≤8MB multipart 直传 → >8MB 分片会话
 *   位图断点续传 → complete）→ msg.send type=image|file|video body{file_id,...}
 * - 失败红态可重试（分片重试经位图跳过已传分片；file_id 幂等由服务端 sha 去重兜底）
 * - 传输管理器/多选 阶段二后续（登记）；视频单文件上限沿用 file 域 20MB（放宽随阶段二）
 * D26-O5：仅外壳换 antd Modal（头/尾/关闭由 Modal 承载，按钮→footer）；
 * 预览内容区（图片/视频/文件卡）原样保留；caption→Input、进度条→Progress、错误→Alert。
 */

import { useEffect, useRef, useState } from 'react';
import { Alert, Flex, Input, Modal, Progress, Typography } from 'antd';
import { FileText, ImageIcon } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { formatBytes } from '../../../shared/utils/format';
import { uploadFileSmart } from '../api/files';
import { sendFileMessage } from '../api/im';

/** caption 上限（04 篇 §1.2 随图说明） */
const CAPTION_MAX = 500;

interface FileSendPreviewProps {
  convId: string;
  file: File;
  onClose: () => void;
}

/** 发送类型分流：图片=image（可带 caption）；视频=video（附 poster）；其余=file */
type SendKind = 'image' | 'file' | 'video';

/** 上传阶段文案（dedup=秒传命中；resuming=断点续传进行中） */
function phaseText(phase?: 'dedup' | 'direct' | 'chunked' | 'resuming'): string {
  switch (phase) {
    case 'dedup':
      return '秒传命中';
    case 'resuming':
      return '断点续传中';
    default:
      return '上传中';
  }
}

/** 视频元数据（预览元素 onLoadedMetadata 采集；duration 供气泡角标/服务端校验） */
interface VideoMeta {
  durationMs: number;
  width: number;
  height: number;
}

/** 端侧截首帧为 poster（JPEG 0.8；失败返回 null——poster 可缺省） */
async function capturePoster(video: HTMLVideoElement): Promise<File | null> {
  try {
    const v = video;
    v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      v.onseeked = done;
      setTimeout(done, 1500); // seek 卡住兜底
    });
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    if (!blob || blob.size === 0) return null;
    return new File([blob], `poster-${Date.now()}.jpg`, { type: 'image/jpeg' });
  } catch {
    return null;
  }
}

/** 上传+发送全链路：进度回调驱动进度条；任一步失败抛 ApiError */
async function sendWholeFlow(
  convId: string,
  file: File,
  kind: SendKind,
  caption: string,
  videoMeta: VideoMeta | null,
  posterFile: File | null,
  onProgress: (pct: number, phase?: 'dedup' | 'direct' | 'chunked' | 'resuming') => void,
): Promise<void> {
  const uploaded = await uploadFileSmart(file, convId, onProgress);
  if (kind === 'video') {
    let posterId: string | undefined;
    if (posterFile) {
      const poster = await uploadFileSmart(posterFile, convId);
      posterId = poster.id;
    }
    await sendFileMessage(convId, crypto.randomUUID(), 'video', {
      file_id: uploaded.id,
      name: uploaded.name,
      size: uploaded.size,
      ext: uploaded.ext,
      ...(uploaded.contentType ? { contentType: uploaded.contentType } : {}),
      ...(videoMeta ? { duration_ms: videoMeta.durationMs, width: videoMeta.width, height: videoMeta.height } : {}),
      ...(posterId ? { poster_file_id: posterId } : {}),
    });
    return;
  }
  await sendFileMessage(convId, crypto.randomUUID(), kind, {
    file_id: uploaded.id,
    name: uploaded.name,
    size: uploaded.size,
    ext: uploaded.ext,
    ...(kind === 'image' && uploaded.width && uploaded.height ? { width: uploaded.width, height: uploaded.height } : {}),
    ...(kind === 'image' && caption ? { caption } : {}),
    ...(uploaded.contentType ? { contentType: uploaded.contentType } : {}),
  });
}

export function FileSendPreview({ convId, file, onClose }: FileSendPreviewProps) {
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  const kind: SendKind = isImage ? 'image' : isVideo ? 'video' : 'file';
  const [phase, setPhase] = useState<'confirm' | 'uploading' | 'error'>('confirm');
  const [progress, setProgress] = useState(0);
  const [upPhase, setUpPhase] = useState<'dedup' | 'direct' | 'chunked' | 'resuming' | undefined>();
  const [errorText, setErrorText] = useState('');
  /** caption 附言（image 专用；≤500 字） */
  const [caption, setCaption] = useState('');
  /** 视频元数据（预览元素采集；发送随 body 透传） */
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** 本地预览 objectURL（图片缩略/视频播放；用后即毁） */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage && !isVideo) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage, isVideo]);

  const doSend = async () => {
    setPhase('uploading');
    setProgress(0);
    setUpPhase(undefined);
    setErrorText('');
    // video：发送前截首帧为 poster（尽力而为，失败不带）
    let posterFile: File | null = null;
    if (kind === 'video' && videoRef.current) {
      posterFile = await capturePoster(videoRef.current);
    }
    sendWholeFlow(convId, file, kind, caption.trim(), videoMeta, posterFile, (pct, p) => {
      setProgress(pct);
      setUpPhase(p);
    })
      .then(() => onClose())
      .catch((err: unknown) => {
        const code = err instanceof ApiError ? err.code : 0;
        setErrorText(code > 0 ? getErrorText(code) : '发送失败，请重试');
        setPhase('error');
      });
  };

  return (
    <Modal
      open
      title={`发送${isImage ? '图片' : isVideo ? '视频' : '文件'}`}
      width={440}
      onCancel={onClose}
      destroyOnClose
      data-testid="file-send-preview"
      footer={
        <Flex align="center" justify="space-between" gap={12}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            不压缩原图 · ≤20MB · 大文件自动分片续传{isVideo ? ' · 自动截取封面帧' : ''}
          </Typography.Text>
          <Flex gap={8}>
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            {phase === 'error' ? (
              <Button data-testid="file-send-retry" onClick={doSend}>
                重试
              </Button>
            ) : (
              <Button disabled={phase === 'uploading'} data-testid="file-send-confirm" onClick={doSend}>
                发送
              </Button>
            )}
          </Flex>
        </Flex>
      }
    >
      {/* 预览内容区（图片/视频/文件卡，保留项——原样不动） */}
      <div className="file-send-preview__body">
        {isImage && previewUrl ? (
          <img className="file-send-preview__thumb" src={previewUrl} alt={file.name} data-testid="file-send-preview-thumb" />
        ) : isVideo && previewUrl ? (
          <video
            ref={videoRef}
            className="file-send-preview__video"
            src={previewUrl}
            controls
            muted
            preload="metadata"
            data-testid="file-send-preview-video"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.duration && Number.isFinite(v.duration)) {
                setVideoMeta({ durationMs: Math.round(v.duration * 1000), width: v.videoWidth, height: v.videoHeight });
              }
            }}
          />
        ) : (
          <div className="file-send-preview__file-icon">
            <FileText size={22} />
          </div>
        )}
        <div className="file-send-preview__meta">
          <div className="file-send-preview__name" title={file.name}>
            {isImage ? <ImageIcon size={13} /> : null}
            {file.name}
          </div>
          <div className="file-send-preview__size">
            {formatBytes(file.size)}
            {isVideo && videoMeta ? ` · ${Math.round(videoMeta.durationMs / 1000)}s` : ''}
          </div>
        </div>
      </div>

      {/* caption 附言（image 专用，04 §1.2 第 5 类：随图说明渲染于缩略图下方） */}
      {isImage ? (
        <Input
          data-testid="file-send-caption"
          placeholder="添加随图说明（可选，≤500 字）"
          value={caption}
          maxLength={CAPTION_MAX}
          disabled={phase === 'uploading'}
          onChange={(e) => setCaption(e.target.value)}
          style={{ marginTop: 12 }}
        />
      ) : null}

      {phase === 'uploading' ? (
        <Flex align="center" gap={8} data-testid="file-send-progress" style={{ marginTop: 12 }}>
          <Progress percent={progress} showInfo={false} style={{ flex: 1, margin: 0 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {progress >= 100 ? '发送中…' : `${phaseText(upPhase)} ${progress}%`}
          </Typography.Text>
        </Flex>
      ) : null}

      {phase === 'error' ? (
        <Alert type="error" showIcon message={errorText} data-testid="file-send-error" style={{ marginTop: 12 }} />
      ) : null}
    </Modal>
  );
}
