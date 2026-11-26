/**
 * 表情选择器（INT-IM-25 完整版 + 0022 自定义表情包；D26-O7 antd 化）：
 * 双模式——emoji 分类面板（插入文本/消息回应）与表情包面板（我的+公共集，
 * 点击即发送 sticker 消息，上传经 file 域两步流）。
 * 换装：模式/分类 → antd Tabs；「常用」页签 Tag 化；网格内联 grid；
 * StickerThumb（票据缩略图）组件原样不动（管理页复用）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Flex, Tabs, Tag, Typography, theme } from 'antd';
import { Plus, X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { getErrorText } from '../../../shared/api/http';
import { useFileDrop } from '../../../shared/hooks/useFileDrop';
import { downloadUrl, getDownloadTicket, uploadFileSmart } from '../api/files';
import {
  addStickerItem,
  createStickerSet,
  fetchStickerLibrary,
  removeStickerItem,
  type StickerItem,
  type StickerLibrary,
} from '../api/stickers';

const { Text } = Typography;

interface Category {
  key: string;
  icon: string;
  label: string;
  emojis: string[];
}

const CATEGORIES: Category[] = [
  {
    key: 'recent',
    icon: '🕐',
    label: '常用',
    emojis: ['👍', '❤️', '😂', '🎉', '🙏', '🔥', '✅', '🤔', '👌', '💪', '👀', '🥰', '😭', '😡', '😮', '😥', '🚀', '☕', '💀', '🫡', '😴', '💤', '🤝', '👏', '💯', '🤞', '😅', '🥳', '😎', '🤗', '🙈', '🫶'],
  },
  {
    key: 'smileys',
    icon: '😀',
    label: '表情',
    emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😋', '😛', '😜', '🤪', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😏', '😒', '🙄', '😬', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🥵', '🥶', '🥴', '🤯', '🥳', '😎', '🤓', '😕', '😟', '😮', '😲', '😳', '🥺', '😢', '😭', '😱', '😖', '😞', '😩', '🥱', '😤', '😡', '🤬', '😈', '👻', '👽', '🤖', '💩', '🤡'],
  },
  {
    key: 'gestures',
    icon: '👋',
    label: '手势与人物',
    emojis: ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💪', '🦾', '👀', '👁️', '👄', '👶', '🧑', '👤', '👥', '🏃', '🚶', '🧗', '🏊', '🚴', '💃', '🕺', '👯', '🧘'],
  },
  {
    key: 'nature',
    icon: '🐼',
    label: '动物与自然',
    emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦆', '🦅', '🦉', '🐺', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐢', '🐍', '🦖', '🐙', '🦀', '🐬', '🐳', '🌈', '☀️', '🌙', '⭐', '✨', '⚡', '🔥', '☄️', '❄️', '🌊', '🌸', '🌺', '🌻', '🌹', '🍀', '🌳', '🌴', '🌵', '🍃', '🍂', '🌷', '💐', '🌱', '🌾', '🪴', '☃️'],
  },
  {
    key: 'food',
    icon: '🍔',
    label: '食物与饮料',
    emojis: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🌽', '🥕', '🥔', '🍞', '🥐', '🧀', '🥚', '🍳', '🥞', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🥪', '🌮', '🍜', '🍝', '🍣', '🍱', '🍤', '🍚', '🍥', '🍡', '🍦', '🍰', '🎂', '🍮', '🍭', '🍫', '🍿', '🍩', '🍪', '☕', '🍵', '🧃', '🥤', '🍺', '🍻', '🥂', '🍷', '🥤'],
  },
  {
    key: 'activity',
    icon: '⚽',
    label: '活动',
    emojis: ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱', '🏓', '🏸', '🥅', '⛳', '🎣', '🎮', '🕹️', '🎲', '🧩', '🎯', '🎳', '🎤', '🎧', '🎸', '🎹', '🎺', '🎻', '🥁', '🎬', '🎨', '🚀', '✈️', '🚗', '🚕', '🚌', '🚲', '🛵', '🏁', '🎉', '🎊', '🎈', '🎁', '🎀', '🏅', '🥇', '🥈', '🥉', '🏆', '🎬', '🎪', '🎭', '🎫'],
  },
  {
    key: 'objects',
    icon: '💡',
    label: '物品',
    emojis: ['⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '💾', '📷', '📸', '📹', '🎥', '📞', '📺', '📻', '⏰', '⌛', '⏳', '📡', '🔋', '🔌', '💡', '🔦', '🕯️', '💸', '💵', '💳', '🧾', '💎', '⚖️', '🧰', '🔧', '🔨', '⚙️', '🔒', '🔑', '🗝️', '🚪', '🪑', '🛏️', '🚿', '🛁', '🧹', '🧺', '🛒', '📦', '📁', '📂', '✂️', '📌', '📎', '📏', '📐', '📑', '📊', '📈', '📉', '🗓️', '🗑️', '🆚'],
  },
  {
    key: 'symbols',
    icon: '❤️',
    label: '符号',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💯', '💢', '💥', '💫', '💦', '💨', '🕳️', '💬', '👁️‍🗨️', '🗨️', '🗯️', '💭', '💤', '❗', '❓', '✅', '❌', '⭕', '🛑', '⛔', '🚫', '❎', '🆗', '🆕', '🆙', '🆒', '🆓', '🆖', '🔢', '🔣', '🏧', '🔱', '🔰', '⚠️', '♻️', '🔝', '🔙', '🔚', '🔜', '🈯', '🈁'],
  },
];

interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  /** 表情包点击（发送 sticker 消息；不传=隐藏表情包页签，如消息回应 popover） */
  onPickSticker?: (item: StickerItem) => void;
  className?: string;
}

export function EmojiPicker({ onPick, onPickSticker }: EmojiPickerProps) {
  const { token } = theme.useToken();
  const [mode, setMode] = useState<'emoji' | 'sticker'>('emoji');
  const [tab, setTab] = useState(CATEGORIES[0].key);

  /** 分类页签内容：常用=Tag 化，其余=内联 grid 按钮 */
  const gridOf = (c: Category) =>
    c.key === 'recent' ? (
      <Flex gap={4} wrap style={{ padding: 6, maxHeight: 176, overflowY: 'auto' }}>
        {c.emojis.map((e, i) => (
          <Tag
            key={`${e}-${i}`}
            onClick={() => onPick(e)}
            style={{
              cursor: 'pointer',
              marginInlineEnd: 0,
              fontSize: 18,
              lineHeight: 1.4,
              padding: '2px 6px',
              borderRadius: 6,
              background: 'transparent',
              border: '1px solid transparent',
              userSelect: 'none',
            }}
          >
            {e}
          </Tag>
        ))}
      </Flex>
    ) : (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(8, 1fr)',
          gap: 2,
          padding: 6,
          maxHeight: 176,
          overflowY: 'auto',
        }}
      >
        {c.emojis.map((e, i) => (
          <button
            key={`${e}-${i}`}
            type="button"
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: 18,
              padding: 3,
              borderRadius: 4,
              cursor: 'pointer',
              lineHeight: 1.4,
            }}
            onClick={() => onPick(e)}
          >
            {e}
          </button>
        ))}
      </div>
    );

  return (
    <div data-testid="emoji-picker" style={{ width: 312 }}>
      <Tabs
        activeKey={mode}
        onChange={(k) => setMode(k as 'emoji' | 'sticker')}
        size="small"
        destroyInactiveTabPane
        style={{ color: token.colorText }}
        items={[
          { key: 'emoji', label: 'Emoji' },
          ...(onPickSticker ? [{ key: 'sticker', label: '表情包' }] : []),
        ]}
      />
      {mode === 'emoji' ? (
        <Tabs
          activeKey={tab}
          onChange={setTab}
          size="small"
          items={CATEGORIES.map((c) => ({
            key: c.key,
            label: <span title={c.label}>{c.icon}</span>,
            children: gridOf(c),
          }))}
        />
      ) : (
        <StickerPanel onPickSticker={onPickSticker!} />
      )}
    </div>
  );
}

/** 表情包面板（首次进入懒加载；我的集+公共集；上传/删除即时刷新；内联 grid 化） */
function StickerPanel({ onPickSticker }: { onPickSticker: (item: StickerItem) => void }) {
  const { token } = theme.useToken();
  const [lib, setLib] = useState<StickerLibrary | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setLib(await fetchStickerLibrary());
    } catch (err) {
      setErrorText(getErrorText((err as { code?: number }).code ?? 9004));
    }
  }, []);

  useEffect(() => {
    if (!lib) void reload();
  }, [lib, reload]);

  const doUpload = async (file: File) => {
    setBusy(true);
    setErrorText('');
    try {
      const up = await uploadFileSmart(file);
      // 无个人集则先建默认集（服务端个人集上限 10）
      let set = lib?.mine[0];
      if (!set) {
        set = await createStickerSet('我的表情');
      }
      await addStickerItem(set.id, up.id, file.name.replace(/\.[^.]+$/, ''));
      await reload();
    } catch (err) {
      setErrorText(getErrorText((err as { code?: number }).code ?? 9004));
    } finally {
      setBusy(false);
    }
  };

  // 图片拖进面板即上传进我的表情（2026-11-26「文件选择全功能点支持拖拽」）；须在早退 return 之前守 hooks 规则
  const { isOver: imgDragOver, dropProps: imgDropProps } = useFileDrop({
    onFiles: (files) => void doUpload(files[0]),
    accept: 'image/*',
    disabled: busy,
    onReject: () => setErrorText('仅支持图片文件'),
  });

  const doRemove = async (itemId: string) => {
    try {
      await removeStickerItem(itemId);
      await reload();
    } catch (err) {
      setErrorText(getErrorText((err as { code?: number }).code ?? 9004));
    }
  };

  if (errorText && !lib)
    return (
      <Text type="secondary" style={{ display: 'block', padding: 16, textAlign: 'center', fontSize: 12 }}>
        {errorText}
      </Text>
    );
  if (!lib)
    return (
      <Text type="secondary" style={{ display: 'block', padding: 16, textAlign: 'center', fontSize: 12 }}>
        加载中…
      </Text>
    );

  const sections: Array<{ title: string; sets: typeof lib.mine; removable: boolean }> = [
    { title: '我的表情', sets: lib.mine, removable: true },
    { title: '公共表情', sets: lib.public, removable: false },
  ];

  return (
    <div
      data-testid="sticker-panel"
      {...imgDropProps}
      style={{
        maxHeight: 232,
        overflowY: 'auto',
        padding: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        borderRadius: token.borderRadius,
        boxShadow: imgDragOver ? `inset 0 0 0 1.5px ${token.colorPrimary}` : undefined,
      }}
    >
      {sections.map(({ title, sets, removable }) =>
        sets.length === 0 && title === '公共表情' ? null : (
          <div key={title} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Flex align="center" gap={8}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {title}
              </Text>
              {removable ? (
                <>
                  <Button
                    variant="text"
                    size="small"
                    title="上传表情图片（≤20MB）"
                    disabled={busy}
                    style={{ fontSize: 12, padding: '2px 6px', height: 'auto', color: token.colorPrimary }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Plus size={13} /> 上传
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) void doUpload(f);
                    }}
                  />
                </>
              ) : null}
            </Flex>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
              {sets.flatMap((s) =>
                s.items.map((it) => (
                  <div key={it.id} style={{ position: 'relative' }}>
                    <button
                      type="button"
                      title={it.name ?? '表情'}
                      style={{ border: 'none', background: 'transparent', padding: 2, borderRadius: 6, cursor: 'pointer', display: 'flex', width: '100%' }}
                      onClick={() => onPickSticker(it)}
                    >
                      <StickerThumb fileId={it.fileId} />
                    </button>
                    {removable ? (
                      <Button
                        variant="text"
                        size="small"
                        title="删除"
                        style={{
                          position: 'absolute',
                          top: -4,
                          right: -4,
                          width: 16,
                          height: 16,
                          minWidth: 16,
                          padding: 0,
                          borderRadius: '50%',
                          background: token.colorTextTertiary,
                          color: '#fff',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        icon={<X size={10} />}
                        onClick={() => void doRemove(it.id)}
                      />
                    ) : null}
                  </div>
                )),
              )}
              {sets.every((s) => s.items.length === 0) ? (
                <Text type="secondary" style={{ gridColumn: '1 / -1', padding: '4px 0', fontSize: 12 }}>
                  {removable ? '还没有表情，点「上传」添加' : '暂无'}
                </Text>
              ) : null}
            </div>
          </div>
        ),
      )}
      {errorText ? (
        <Text type="danger" style={{ padding: 4, fontSize: 12 }}>
          {errorText}
        </Text>
      ) : null}
    </div>
  );
}

/** 表情缩略图：票据 → blob → objectURL（一次性票据不可直接作 src 复用，同图片口径；管理页复用） */
export function StickerThumb({ fileId }: { fileId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const t = await getDownloadTicket(fileId);
        const resp = await fetch(downloadUrl(t.url));
        if (!resp.ok) return;
        const blob = await resp.blob();
        if (!alive) return;
        const u = URL.createObjectURL(blob);
        urlRef.current = u;
        setUrl(u);
      } catch {
        /* 失败留占位 */
      }
    })();
    return () => {
      alive = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [fileId]);

  return url ? <img src={url} alt="" className="sticker-panel__img" /> : <span className="sticker-panel__ph" />;
}
