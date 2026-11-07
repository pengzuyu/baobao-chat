/**
 * 分享外链解析页（D06 §4.4；路由 /s/:code，登录态访问——企业内不匿名）：
 * - 进入即解析：无密码 → 4011 need_pwd 二段式（密码输入重解析）
 * - 命中 → 文件卡片 + 剩余次数 + [下载]（一次性票据 120s 流式回放）
 * - 终态错误：4010 过期 / 4012 次数尽 / 4005 已取消或不存在（不可重试）
 * - mock 模式无服务端——给占位说明
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, FileText, Lock } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { formatBytes } from '../../../shared/utils/format';
import { downloadUrl, resolveFileShare, type ShareView } from '../api/files';

type PageState =
  | { kind: 'loading' }
  | { kind: 'need-pwd' }
  | { kind: 'done'; view: ShareView }
  | { kind: 'dead'; code: number } // 终态（4010/4012/4005 等，不可重试）
  | { kind: 'retryable'; text: string }; // 网络/临时错误（可再试）

export function ShareResolvePage() {
  const { code = '' } = useParams<{ code: string }>();
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const resolve = useCallback(
    async (pwd?: string) => {
      setBusy(true);
      try {
        const view = await resolveFileShare(code, pwd);
        setState({ kind: 'done', view });
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.code === 4011 && !pwd) {
            setState({ kind: 'need-pwd' }); // 二段式：首次未携带密码
          } else if (e.code === 4010 || e.code === 4012 || e.code === 4005 || e.code === 4013) {
            setState({ kind: 'dead', code: e.code });
          } else {
            setState({ kind: 'retryable', text: getErrorText(e.code) });
          }
        } else {
          setState({ kind: 'retryable', text: '解析失败，请稍后重试' });
        }
      } finally {
        setBusy(false);
      }
    },
    [code],
  );

  useEffect(() => {
    void resolve();
  }, [resolve]);

  return (
    <div className="share-resolve" data-testid="share-resolve">
      <div className="share-resolve__card">
        <div className="share-resolve__head">
          <Link to="/im" className="share-resolve__back" title="返回消息">
            <ArrowLeft size={14} />
          </Link>
          <span className="share-resolve__title">分享文件</span>
          <code className="share-resolve__code" title={code}>
            /s/{code.slice(0, 8)}…
          </code>
        </div>

        {state.kind === 'loading' ? <div className="share-resolve__body">解析中…</div> : null}

        {state.kind === 'need-pwd' ? (
          <div className="share-resolve__body">
            <div className="share-resolve__file">
              <div className="share-resolve__icon">
                <Lock size={20} />
              </div>
              <div className="share-resolve__meta">
                <div className="share-resolve__name">该分享已加密</div>
                <div className="share-resolve__sub">输入密码后查看文件</div>
              </div>
            </div>
            <div className="share-resolve__pwd">
              <div className="bbw-input">
                <input
                  type="password"
                  placeholder="分享密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && password && !busy && void resolve(password)}
                  data-testid="share-pwd-input"
                />
              </div>
              <button
                type="button"
                className="share-resolve__btn"
                disabled={busy || !password}
                onClick={() => void resolve(password)}
                data-testid="share-pwd-submit"
              >
                {busy ? '验证中…' : '查看'}
              </button>
            </div>
          </div>
        ) : null}

        {state.kind === 'done' ? (
          <div className="share-resolve__body">
            <div className="share-resolve__file">
              <div className="share-resolve__icon">
                <FileText size={20} />
              </div>
              <div className="share-resolve__meta">
                <div className="share-resolve__name" title={state.view.file.name}>
                  {state.view.file.name}
                </div>
                <div className="share-resolve__sub">
                  {formatBytes(state.view.file.size)}
                  {state.view.max_times
                    ? ` · 已访问 ${state.view.used_times}/${state.view.max_times} 次`
                    : state.view.used_times > 0
                      ? ` · 第 ${state.view.used_times} 次访问`
                      : ''}
                </div>
              </div>
              <button
                type="button"
                className="share-resolve__btn share-resolve__btn--primary"
                onClick={() => window.open(downloadUrl(state.view.ticket.url), '_blank')}
                data-testid="share-download-btn"
              >
                <Download size={14} /> 下载
              </button>
            </div>
            <div className="share-resolve__hint">下载票据 120 秒内有效（一次性）</div>
          </div>
        ) : null}

        {state.kind === 'dead' ? (
          <div className="share-resolve__body">
            <div className="share-resolve__dead" data-testid="share-dead">
              {getErrorText(state.code)}
            </div>
            <Link to="/im" className="share-resolve__btn">
              返回消息
            </Link>
          </div>
        ) : null}

        {state.kind === 'retryable' ? (
          <div className="share-resolve__body">
            <div className="share-resolve__dead">{state.text}</div>
            <button type="button" className="share-resolve__btn" disabled={busy} onClick={() => void resolve()}>
              重试
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
