/**
 * 发送前预览弹层（D06 PFL-03 阶段一务实版）：
 * - 图片显示本地缩略（objectURL）；文件显示名/大小（压缩选项不做，登记）
 * - 发送 = POST /files/upload（XHR 进度条）→ 成功后 msg.send type=image|file body{file_id,...}
 * - 失败红态可重试（整链路重跑；file_id 幂等由服务端 sha 去重兜底）
 * - 传输管理器/多选/备注 caption 阶段二（登记）
 */

import { useEffect, useState } from 'react';
import { FileText, ImageIcon, X } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { formatBytes } from '../../../shared/utils/format';
import { uploadFile } from '../api/files';
import { sendFileMessage } from '../api/im';

interface FileSendPreviewProps {
  convId: string;
  file: File;
  onClose: () => void;
}

/** 上传+发送全链路：进度回调驱动进度条；任一步失败抛 ApiError */
async function sendWholeFlow(
  convId: string,
  file: File,
  isImage: boolean,
  onProgress: (pct: number) => void,
): Promise<void> {
  const uploaded = await uploadFile(file, convId, onProgress);
  await sendFileMessage(convId, crypto.randomUUID(), isImage ? 'image' : 'file', {
    file_id: uploaded.id,
    name: uploaded.name,
    size: uploaded.size,
    ext: uploaded.ext,
    ...(isImage && uploaded.width && uploaded.height ? { width: uploaded.width, height: uploaded.height } : {}),
    ...(uploaded.contentType ? { contentType: uploaded.contentType } : {}),
  });
}

export function FileSendPreview({ convId, file, onClose }: FileSendPreviewProps) {
  const isImage = file.type.startsWith('image/');
  const [phase, setPhase] = useState<'confirm' | 'uploading' | 'error'>('confirm');
  const [progress, setProgress] = useState(0);
  const [errorText, setErrorText] = useState('');
  /** 本地预览 objectURL（图片缩略；用后即毁） */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  // Esc 关闭（仅确认/失败态；上传中关闭=放弃）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doSend = () => {
    setPhase('uploading');
    setProgress(0);
    setErrorText('');
    sendWholeFlow(convId, file, isImage, (pct) => setProgress(pct))
      .then(() => onClose())
      .catch((err: unknown) => {
        const code = err instanceof ApiError ? err.code : 0;
        setErrorText(code > 0 ? getErrorText(code) : '发送失败，请重试');
        setPhase('error');
      });
  };

  return (
    <div className="modal-mask" data-testid="file-send-preview" onClick={onClose}>
      <div className="file-send-preview" onClick={(e) => e.stopPropagation()}>
        <div className="file-send-preview__head">
          <span>发送{isImage ? '图片' : '文件'}</span>
          <button type="button" className="file-send-preview__close" title="关闭 (Esc)" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="file-send-preview__body">
          {isImage && previewUrl ? (
            <img className="file-send-preview__thumb" src={previewUrl} alt={file.name} data-testid="file-send-preview-thumb" />
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
            <div className="file-send-preview__size">{formatBytes(file.size)}</div>
          </div>
        </div>

        {phase === 'uploading' ? (
          <div className="file-send-preview__progress" data-testid="file-send-progress">
            <div className="file-send-preview__progress-bar">
              <div className="file-send-preview__progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="file-send-preview__progress-text">
              {progress >= 100 ? '发送中…' : `上传中 ${progress}%`}
            </span>
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="file-send-preview__error" data-testid="file-send-error">
            {errorText}
          </div>
        ) : null}

        <div className="file-send-preview__foot">
          <span className="file-send-preview__hint">阶段一不压缩原图 · ≤20MB</span>
          <div className="file-send-preview__actions">
            <button type="button" className="file-send-preview__btn" onClick={onClose}>
              取消
            </button>
            {phase === 'error' ? (
              <button type="button" className="file-send-preview__btn file-send-preview__btn--primary" data-testid="file-send-retry" onClick={doSend}>
                重试
              </button>
            ) : (
              <button
                type="button"
                className="file-send-preview__btn file-send-preview__btn--primary"
                data-testid="file-send-confirm"
                disabled={phase === 'uploading'}
                onClick={doSend}
              >
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
