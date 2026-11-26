/**
 * 批量导入用户弹窗（2026-11-18 收编组织用户页；原独立 ImportPage 退役）：
 * - 导入前选目标组织（无组织=虚拟「未分组」；默认=左栏当前选中部门，可改）
 * - 文件只认姓名：粘贴 CSV（每行首列=姓名，多余列忽略，# 注释行跳过）或上传
 *   Excel（.xlsx/.xls 首表首列=姓名，表头「姓名/name」自动跳过）
 * - 工号/邮箱不支持自定义，服务端按规范生成：工号=姓名全拼（重名两位补零递增）、
 *   邮箱=工号@BBC_MAIL_DOMAIN（与单建弹窗 MAIL_DOMAIN 品牌单源同后缀）；初始口令=
 *   工号+!BBC 首登强制改密；≤100 行/次
 * - 结果表回显每行生成的工号/邮箱（管理员分发首登凭据的依据）
 * 样式对齐 CreateUserModal（Typography 标签+自研 Button）；隐藏 file input 保留——
 * antd Upload 不参与（ImportPage 旧口径）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Alert, Input, Modal, Select, Space, Table, Tag, Typography, theme } from 'antd';
import { FileUp } from 'lucide-react';
import { errText } from '../../../shared/api/http';
import { MAIL_DOMAIN } from '../../../shared/brand';
import { Button } from '../../../shared/ui/Button';
import { useFileDrop } from '../../../shared/hooks/useFileDrop';
import { batchImportUsers, type DeptNode, type ImportInputRow, type ImportResult } from '../api/admin';

/** 部门树 → 缩进扁平清单（组织下拉展示用；OrgDirectoryPage 共用） */
export function flattenTree(
  nodes: DeptNode[],
  depth = 0,
  out: { id: string; name: string; depth: number }[] = [],
): { id: string; name: string; depth: number }[] {
  for (const n of nodes) {
    out.push({ id: n.id, name: n.name, depth });
    if (n.children?.length) flattenTree(n.children, depth + 1, out);
  }
  return out;
}

type Step = 'input' | 'result';

/** CSV 行解析：首列=姓名（多余列忽略；中英文逗号/制表符容忍；# 注释行跳过） */
function parseCSV(text: string): { rows: ImportInputRow[]; bad: number } {
  const rows: ImportInputRow[] = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const name = t.split(/[,，\t]/)[0].trim();
    if (!name) {
      bad++;
      continue;
    }
    rows.push({ name });
  }
  return { rows, bad };
}

/** Excel 解析（SheetJS）：首表逐行取首列（列序：姓名；首行若为表头文字则跳过） */
async function parseExcel(file: File): Promise<{ rows: ImportInputRow[]; bad: number }> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [], bad: 0 };
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
  const rows: ImportInputRow[] = [];
  let bad = 0;
  for (const cells of matrix) {
    const name = String(cells[0] ?? '').trim();
    if (!name && !String(cells[1] ?? '').trim()) continue; // 空行
    // 表头行启发：首列含「姓名/name」字样 → 跳过
    if (rows.length === 0 && /姓名|name/i.test(name)) continue;
    if (!name) {
      bad++;
      continue;
    }
    rows.push({ name });
  }
  return { rows, bad };
}

export function ImportUsersModal({
  open,
  tree,
  defaultDeptId,
  onClose,
  onImported,
}: {
  open: boolean;
  tree: DeptNode[];
  /** 触发时左栏选中部门（'' = 全公司/无组织） */
  defaultDeptId: string;
  onClose: () => void;
  /** 提交成功即回调（父页刷新列表；结果明细由弹窗自己展示） */
  onImported: (r: ImportResult) => void;
}) {
  const [step, setStep] = useState<Step>('input');
  const [dept, setDept] = useState(defaultDeptId);
  const [text, setText] = useState('');
  const [excelRows, setExcelRows] = useState<{ rows: ImportInputRow[]; bad: number } | null>(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const flat = useMemo(() => flattenTree(tree), [tree]);
  const parsed = excelRows ?? parseCSV(text);

  // 开弹窗复位到输入步（组织默认跟随触发节点；数据清空）
  useEffect(() => {
    if (!open) return;
    setStep('input');
    setDept(defaultDeptId);
    setText('');
    setExcelRows(null);
    setFileName('');
    setResult(null);
    setError('');
  }, [open, defaultDeptId]);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    try {
      const parsedFile = await parseExcel(file);
      setExcelRows(parsedFile);
      setFileName(`${file.name}（${parsedFile.rows.length} 行）`);
    } catch {
      setError('Excel 解析失败（支持 .xlsx/.xls；首列=姓名）');
    }
  };

  // Excel 拖入弹窗（2026-11-26「文件选择全功能点支持拖拽」）：与点击选择同走 pickFile；非输入步/提交中让路
  const { token } = theme.useToken();
  const { isOver: fileDragOver, dropProps: fileDropProps } = useFileDrop({
    onFiles: (files) => void pickFile(files[0]),
    accept: '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel',
    disabled: step !== 'input' || busy,
  });

  const backToPaste = () => {
    setExcelRows(null);
    setFileName('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await batchImportUsers(dept, parsed.rows);
      setResult(res);
      setStep('result');
      onImported(res);
    } catch (e) {
      setError(errText(e, '导入失败'));
    } finally {
      setBusy(false);
    }
  };

  /** 继续导入：回输入步清数据，组织选择保留 */
  const again = () => {
    setStep('input');
    setText('');
    setExcelRows(null);
    setFileName('');
    setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const deptLabel = dept ? flat.find((d) => d.id === dept)?.name ?? dept : '无组织（未分组）';

  return (
    <Modal
      open={open}
      title="批量导入用户"
      onCancel={onClose}
      destroyOnClose
      width={720}
      data-testid="dir-import-modal"
      {...fileDropProps}
      styles={{ body: fileDragOver ? { boxShadow: `inset 0 0 0 2px ${token.colorPrimary}`, borderRadius: token.borderRadius } : undefined }}
      footer={[
        step === 'input' ? (
          <Button key="cancel" variant="secondary" onClick={onClose}>
            取消
          </Button>
        ) : (
          <Button key="again" variant="secondary" onClick={again}>
            继续导入
          </Button>
        ),
        step === 'input' ? (
          <Button
            key="ok"
            loading={busy}
            disabled={parsed.rows.length === 0 || parsed.rows.length > 100}
            onClick={() => void submit()}
            data-testid="dir-import-submit"
          >
            {busy ? '导入中…' : `导入 ${Math.min(parsed.rows.length, 100)} 行`}
          </Button>
        ) : (
          <Button key="done" onClick={onClose}>
            完成
          </Button>
        ),
      ]}
    >
      {step === 'input' ? (
        <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 8 }}>
          <Typography.Text>导入到组织</Typography.Text>
          <Select
            value={dept}
            onChange={setDept}
            style={{ width: '100%' }}
            data-testid="dir-import-dept"
            options={[
              { value: '', label: '无组织（未分组）' },
              ...flat.map((d) => ({ value: d.id, label: `${'　'.repeat(d.depth)}${d.name}` })),
            ]}
          />
          <Space size={8} wrap style={{ marginTop: 4 }}>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={(e) => void pickFile(e.target.files?.[0])}
              data-testid="dir-import-file-input"
            />
            <Button variant="secondary" onClick={() => fileRef.current?.click()} data-testid="dir-import-file-btn">
              <FileUp size={14} /> 上传 Excel（.xlsx/.xls）
            </Button>
            {excelRows ? (
              <>
                <Typography.Text data-testid="dir-import-file-name">{fileName}</Typography.Text>
                <Button variant="secondary" size="small" onClick={backToPaste}>
                  改用粘贴
                </Button>
              </>
            ) : null}
          </Space>
          {excelRows ? null : (
            <Input.TextArea
              autoSize={{ minRows: 8, maxRows: 16 }}
              placeholder={'# 示例（# 开头为注释行；每行首列=姓名，多余列忽略）\n张三\n李四,备注列可忽略'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              data-testid="dir-import-csv"
            />
          )}
          <Typography.Text type="secondary">
            解析 {parsed.rows.length} 行（{excelRows ? 'Excel' : 'CSV 粘贴'}）
            {parsed.bad > 0 ? `（${parsed.bad} 行格式非法将被跳过）` : ''} · ≤100 行/次
          </Typography.Text>
          <Typography.Text type="secondary">
            工号与邮箱由系统自动生成（工号=姓名全拼、重名补零递增；邮箱=工号@{MAIL_DOMAIN}），不支持自定义；初始口令=工号+“!BBC”，首登强制改密
          </Typography.Text>
          {error ? <Alert type="error" showIcon message={error} /> : null}
        </Space>
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
          <Typography.Text>
            已导入到「{deptLabel}」：成功 <Typography.Text strong>{result?.created ?? 0}</Typography.Text> · 失败{' '}
            <Typography.Text strong>{result?.failed ?? 0}</Typography.Text>
          </Typography.Text>
          <Table
            rowKey="row"
            size="small"
            data-testid="dir-import-result-table"
            dataSource={result?.rows ?? []}
            pagination={false}
            onRow={() => ({ 'data-testid': 'dir-import-result-row' } as React.HTMLAttributes<HTMLTableRowElement>)}
            columns={[
              { title: '行', dataIndex: 'row', width: 50 },
              { title: '姓名', dataIndex: 'name', width: 110 },
              {
                title: '工号（登录账号）',
                dataIndex: 'empno',
                width: 150,
                render: (v: string | undefined) => (v ? <Typography.Text code>{v}</Typography.Text> : '—'),
              },
              {
                title: '邮箱',
                dataIndex: 'email',
                render: (v: string | undefined) => (v ? <Typography.Text code>{v}</Typography.Text> : '—'),
              },
              {
                title: '结果',
                key: 'ok',
                width: 150,
                render: (_, r) =>
                  r.ok ? (
                    <Tag color="geekblue">成功</Tag>
                  ) : (
                    <Typography.Text type="danger">{r.reason}</Typography.Text>
                  ),
              },
            ]}
          />
          <Typography.Text type="secondary">初始口令=工号+“!BBC”，请将工号告知成员（首登强制改密）</Typography.Text>
        </Space>
      )}
    </Modal>
  );
}
