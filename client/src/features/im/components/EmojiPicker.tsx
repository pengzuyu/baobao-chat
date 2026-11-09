/**
 * 表情选择器（INT-IM-25 完整版 + 0022 自定义表情包）：
 * 双模式——emoji 分类面板（插入文本/消息回应）与表情包面板（我的+公共集，
 * 点击即发送 sticker 消息，上传经 file 域两步流）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { getErrorText } from '../../../shared/api/http';
import { downloadUrl, getDownloadTicket, uploadFileSmart } from '../api/files';
import {
  addStickerItem,
  createStickerSet,
  fetchStickerLibrary,
  removeStickerItem,
  type StickerItem,
  type StickerLibrary,
} from '../api/stickers';

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

export function EmojiPicker({ onPick, onPickSticker, className = '' }: EmojiPickerProps) {
  const [mode, setMode] = useState<'emoji' | 'sticker'>('emoji');
  const [tab, setTab] = useState(0);
  const cat = CATEGORIES[tab];
  return (
    <div className={`emoji-picker ${className}`} data-testid="emoji-picker">
      <div className="emoji-picker__mode">
        <button
          type="button"
          className={`emoji-picker__mode-btn${mode === 'emoji' ? ' emoji-picker__mode-btn--active' : ''}`}
          onClick={() => setMode('emoji')}
        >
          Emoji
        </button>
        {onPickSticker ? (
          <button
            type="button"
            className={`emoji-picker__mode-btn${mode === 'sticker' ? ' emoji-picker__mode-btn--active' : ''}`}
            onClick={() => setMode('sticker')}
          >
            表情包
          </button>
        ) : null}
      </div>
      {mode === 'emoji' ? (
        <>
          <div className="emoji-picker__tabs" role="tablist">
            {CATEGORIES.map((c, i) => (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={i === tab}
                title={c.label}
                className={`emoji-picker__tab${i === tab ? ' emoji-picker__tab--active' : ''}`}
                onClick={() => setTab(i)}
              >
                {c.icon}
              </button>
            ))}
          </div>
          <div className="emoji-picker__grid">
            {cat.emojis.map((e, i) => (
              <button key={`${e}-${i}`} type="button" className="emoji-picker__item" onClick={() => onPick(e)}>
                {e}
              </button>
            ))}
          </div>
        </>
      ) : (
        <StickerPanel onPickSticker={onPickSticker!} />
      )}
    </div>
  );
}

/** 表情包面板（首次进入懒加载；我的集+公共集；上传/删除即时刷新） */
function StickerPanel({ onPickSticker }: { onPickSticker: (item: StickerItem) => void }) {
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

  const doRemove = async (itemId: string) => {
    try {
      await removeStickerItem(itemId);
      await reload();
    } catch (err) {
      setErrorText(getErrorText((err as { code?: number }).code ?? 9004));
    }
  };

  if (errorText && !lib) return <div className="sticker-panel__empty">{errorText}</div>;
  if (!lib) return <div className="sticker-panel__empty">加载中…</div>;

  const sections: Array<{ title: string; sets: typeof lib.mine; removable: boolean }> = [
    { title: '我的表情', sets: lib.mine, removable: true },
    { title: '公共表情', sets: lib.public, removable: false },
  ];

  return (
    <div className="sticker-panel" data-testid="sticker-panel">
      {sections.map(({ title, sets, removable }) =>
        sets.length === 0 && title === '公共表情' ? null : (
          <div key={title} className="sticker-panel__section">
            <div className="sticker-panel__head">
              <span className="sticker-panel__title">{title}</span>
              {removable ? (
                <>
                  <button
                    type="button"
                    className="sticker-panel__add"
                    title="上传表情图片（≤20MB）"
                    disabled={busy}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Plus size={13} /> 上传
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="attach-input"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) void doUpload(f);
                    }}
                  />
                </>
              ) : null}
            </div>
            <div className="sticker-panel__grid">
              {sets.flatMap((s) =>
                s.items.map((it) => (
                  <div key={it.id} className="sticker-panel__item">
                    <button type="button" title={it.name ?? '表情'} onClick={() => onPickSticker(it)}>
                      <StickerThumb fileId={it.fileId} />
                    </button>
                    {removable ? (
                      <button
                        type="button"
                        className="sticker-panel__del"
                        title="删除"
                        onClick={() => void doRemove(it.id)}
                      >
                        <X size={10} />
                      </button>
                    ) : null}
                  </div>
                )),
              )}
              {sets.every((s) => s.items.length === 0) ? (
                <div className="sticker-panel__empty sticker-panel__empty--inline">
                  {removable ? '还没有表情，点「上传」添加' : '暂无'}
                </div>
              ) : null}
            </div>
          </div>
        ),
      )}
      {errorText ? <div className="sticker-panel__error">{errorText}</div> : null}
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
