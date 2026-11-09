/**
 * 批量导入向导（D10 PAD-06 三步）：粘贴 CSV 或上传 Excel（.xlsx/.xls，SheetJS
 * 解析首表，表头列：工号/姓名/邮箱——顺序同 CSV）→ 预览解析 → 提交导入。
 * v0.1 同步 ≤100 行/次；初始口令=工号+!BBW，**导入即置首登强制改密**（D11：
 * 登录响应 must_change_pwd → 登录页二步改密表单，改密成功清位）。
 */

import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
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

/** Excel 解析（SheetJS）：首表逐行 → 同一行集（列序：工号/姓名/邮箱；首行若为表头文字则跳过） */
async function parseExcel(file: File): Promise<{ rows: ImportInputRow[]; bad: number }> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [], bad: 0 };
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
  const rows: ImportInputRow[] = [];
  let bad = 0;
  for (const cells of matrix) {
    const empno = String(cells[0] ?? '').trim();
    const name = String(cells[1] ?? '').trim();
    const email = String(cells[2] ?? '').trim();
    if (!empno && !name) continue; // 空行
    // 表头行启发：首列含"工号"字样 → 跳过
    if (rows.length === 0 && /工号|emp/i.test(empno)) continue;
    if (!empno || !name) {
      bad++;
      continue;
    }
    rows.push({ empno, name, email: email || undefined });
  }
  return { rows, bad };
}

export function ImportPage() {
  const [step, setStep] = useState<Step>('paste');
  const [text, setText] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Excel 行集（与 CSV 并轨：上传后 parsed 切换来源）
  const [excelRows, setExcelRows] = useState<{ rows: ImportInputRow[]; bad: number } | null>(null);
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = excelRows ?? parseCSV(text);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const parsedFile = await parseExcel(file);
      setExcelRows(parsedFile);
      setFileName(`${file.name}（${parsedFile.rows.length} 行）`);
    } catch {
      setError('Excel 解析失败（支持 .xlsx/.xls；列序：工号,姓名,邮箱）');
    }
  };

  const backToPaste = () => {
    setExcelRows(null);
    setFileName('');
    if (fileRef.current) fileRef.current.value = '';
  };

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
          <div className="admin-import__file">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={(e) => void pickFile(e.target.files?.[0])}
              data-testid="import-file-input"
            />
            <button type="button" className="btn btn--secondary" onClick={() => fileRef.current?.click()} data-testid="import-file-btn">
              <FileUp size={14} /> 上传 Excel（.xlsx/.xls）
            </button>
            {excelRows ? (
              <>
                <span className="admin-import__filename" data-testid="import-file-name">{fileName}</span>
                <button type="button" className="btn btn--sm" onClick={backToPaste}>
                  改用粘贴
                </button>
              </>
            ) : null}
          </div>
          {excelRows ? null : (
          <textarea
            className="gm-textarea admin-import__input"
            rows={12}
            placeholder={'# 示例（# 开头为注释行）\n10021,张三,zhang@corp.io\n10022,李四'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="import-csv-input"
          />
          )}
          <div className="admin-import__meta">
            <FileUp size={14} /> 解析 {parsed.rows.length} 行（{excelRows ? 'Excel' : 'CSV 粘贴'}）
            {parsed.bad > 0 ? <span className="admin-import__bad">（{parsed.bad} 行格式非法将被跳过）</span> : null}
          </div>
          <div className="admin-import__meta admin-import__meta--note">
            初始口令=工号+!BBW，导入用户首登强制改密（登录后弹二步改密表单）
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
