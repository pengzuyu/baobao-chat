/**
 * 批量导入向导（D10 PAD-06 三步）：粘贴 CSV（工号,姓名,邮箱）→ 预览解析
 * （行数/格式提示）→ 提交导入（成功/失败明细）。v0.1 同步 ≤100 行/次；
 * 初始口令=工号+!BBW（首登改密阶段二）。Excel 文件解析随异步任务阶段二。
 */

import { useState } from 'react';
import { ArrowRight, FileUp } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { batchImportUsers, type ImportInputRow, type ImportResult } from '../api/admin';

type Step = 'paste' | 'result';

/** CSV 行解析：工号,姓名[,邮箱]（中英文逗号/制表符容忍；# 注释行跳过） */
function parseCSV(text: string): { rows: ImportInputRow[]; bad: number } {
  const rows: ImportInputRow[] = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/[,，\t]/).map((s) => s.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      bad++;
      continue;
    }
    rows.push({ empno: parts[0], name: parts[1], email: parts[2] || undefined });
  }
  return { rows, bad };
}

export function ImportPage() {
  const [step, setStep] = useState<Step>('paste');
  const [text, setText] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseCSV(text);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await batchImportUsers(parsed.rows));
      setStep('result');
    } catch (e) {
      setError(e instanceof ApiError ? getErrorText(e.code) : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-page__section" data-testid="admin-import">
      <div className="admin-page__head">
        <h2>批量导入用户</h2>
        <span className="admin-import__hint">CSV 每行：工号,姓名[,邮箱] · ≤100 行/次 · 初始口令=工号+!BBW</span>
      </div>
      {error ? <div className="admin-page__error">{error}</div> : null}

      {step === 'paste' ? (
        <>
          <textarea
            className="gm-textarea admin-import__input"
            rows={12}
            placeholder={'# 示例（# 开头为注释行）\n10021,张三,zhang@corp.io\n10022,李四'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="import-csv-input"
          />
          <div className="admin-import__meta">
            <FileUp size={14} /> 解析 {parsed.rows.length} 行
            {parsed.bad > 0 ? <span className="admin-import__bad">（{parsed.bad} 行格式非法将被跳过）</span> : null}
          </div>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || parsed.rows.length === 0 || parsed.rows.length > 100}
            onClick={() => void submit()}
            data-testid="import-submit-btn"
          >
            <ArrowRight size={14} /> {busy ? '导入中…' : `导入 ${Math.min(parsed.rows.length, 100)} 行`}
          </button>
        </>
      ) : (
        <>
          <div className="admin-import__summary">
            成功 <strong>{result?.created ?? 0}</strong> · 失败 <strong>{result?.failed ?? 0}</strong>
          </div>
          <table className="admin-table" data-testid="import-result-table">
            <thead>
              <tr>
                <th>行</th>
                <th>工号</th>
                <th>姓名</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {(result?.rows ?? []).map((r) => (
                <tr key={r.row} data-testid="import-result-row">
                  <td>{r.row}</td>
                  <td>{r.empno}</td>
                  <td>{r.name}</td>
                  <td>{r.ok ? <span className="tag tag--builtin">成功</span> : <span className="admin-import__fail">{r.reason}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setStep('paste');
              setResult(null);
            }}
          >
            继续导入
          </button>
        </>
      )}
    </div>
  );
}
