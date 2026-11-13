/**
 * 表情集治理（0022 自定义表情包，路由 /admin/stickers）：
 * 租户公共表情集——建集 / 上传表情 / 上下架 / 删集；个人集由用户在聊天面板自维护。
 * 权限：admin:policy:manage（服务端守卫 2003 兜底；导航入口随 admin:* 显隐）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Input } from 'antd';
import { ArrowDownToLine, ArrowUpToLine, Plus, Trash2 } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewStateOrOk } from '../../../shared/ui/StateView';
import { uploadFileSmart } from '../../im/api/files';
import { StickerThumb } from '../../im/components/EmojiPicker';
import {
  addAdminStickerItem,
  createAdminStickerSet,
  fetchAdminStickerSets,
  removeAdminStickerSet,
  setAdminStickerStatus,
  type StickerSet,
} from '../../im/api/stickers';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

export function StickersPage() {
  const [sets, setSets] = useState<StickerSet[] | null>(null);
  const [errorText, setErrorText] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setSets(await fetchAdminStickerSets());
      setErrorText('');
    } catch (err) {
      setErrorText(getErrorText((err as { code?: number }).code ?? 9004));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const doCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await createAdminStickerSet(name);
      setNewName('');
      await reload();
    } catch (err) {
      setErrorText(getErrorText((err as { code?: number }).code ?? 9004));
    } finally {
      setBusy(false);
    }
  };

  const state: ViewStateOrOk =
    sets === null && !errorText ? 'loading' : errorText ? 'error' : sets !== null && sets.length === 0 ? 'empty' : 'ok';

  return (
    <div className="admin-stickers">
      <header className="admin-page__header">
        <h2 className="admin-page__title">表情集</h2>
        <span className="admin-page__meta">租户公共表情包（全员可用）· 个人表情由成员在聊天面板自维护</span>
      </header>

      <div className="admin-stickers__create">
        <Input
          className="admin-stickers__input"
          placeholder="新表情集名称（≤50 字）"
          value={newName}
          maxLength={50}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={() => void doCreate()}
          disabled={USE_MOCK}
        />
        <Button onClick={() => void doCreate()} disabled={!newName.trim() || busy}>
          <Plus size={14} /> 建集
        </Button>
      </div>
      {errorText ? <Alert type="error" showIcon message={errorText} style={{ marginBottom: 8 }} /> : null}

      <StateView
        state={state}
        skeleton={<SkeletonList count={3} />}
        emptyText="暂无公共表情集，先建一个"
        error={new ApiError(9004, errorText)}
      >
        <div className="admin-stickers__list">
          {(sets ?? []).map((s) => (
            <SetCard key={s.id} set={s} onReload={reload} onError={setErrorText} />
          ))}
        </div>
      </StateView>
    </div>
  );
}

function SetCard({ set, onReload, onError }: { set: StickerSet; onReload: () => Promise<void>; onError: (t: string) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const live = set.status === 1;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onReload();
      onError('');
    } catch (err) {
      onError(getErrorText((err as { code?: number }).code ?? 9004));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`admin-stickers__set${live ? '' : ' admin-stickers__set--off'}`}>
      <div className="admin-stickers__set-head">
        <span className="admin-stickers__set-name">{set.name}</span>
        <span className="admin-stickers__set-meta">
          {set.items.length} 个表情 · {live ? '已上架' : '已下架'}
        </span>
        <div className="admin-stickers__set-ops">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="attach-input"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) {
                void run(async () => {
                  const up = await uploadFileSmart(f);
                  await addAdminStickerItem(set.id, up.id, f.name.replace(/\.[^.]+$/, ''));
                });
              }
            }}
          />
          <Button size="small" title="上传表情" disabled={busy} onClick={() => fileInputRef.current?.click()}>
            <Plus size={14} /> 上传
          </Button>
          <Button
            size="small"
            title={live ? '下架（全员不可用）' : '上架'}
            disabled={busy}
            onClick={() => void run(() => setAdminStickerStatus(set.id, live ? 2 : 1))}
          >
            {live ? <ArrowDownToLine size={14} /> : <ArrowUpToLine size={14} />} {live ? '下架' : '上架'}
          </Button>
          <Button size="small" variant="danger" title="删除表情集" disabled={busy} onClick={() => void run(() => removeAdminStickerSet(set.id))}>
            <Trash2 size={14} /> 删除
          </Button>
        </div>
      </div>
      <div className="admin-stickers__thumbs">
        {set.items.length === 0 ? (
          <span className="admin-stickers__empty">空集，点「上传」添加表情图片</span>
        ) : (
          set.items.map((it) => (
            <span key={it.id} className="admin-stickers__thumb" title={it.name ?? ''}>
              <StickerThumb fileId={it.fileId} />
            </span>
          ))
        )}
      </div>
    </div>
  );
}
