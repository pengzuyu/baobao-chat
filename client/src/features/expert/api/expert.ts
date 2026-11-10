/**
 * 专家库 API（D14 §5 eco 分发；mock 桩集中底部）。
 */
import { http } from '../../../shared/api/http';
import type { EcoExpert } from '../model/types';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

export async function listExperts(scope: 'company' | 'mine' | 'all' = 'all'): Promise<EcoExpert[]> {
  if (USE_MOCK) return mockExperts().filter((e) => (scope === 'all' ? true : e.source === (scope === 'company' ? 1 : 2)));
  const data = await http.get<EcoExpert[]>(`/eco/experts${scope === 'mine' ? '/mine' : `?scope=${scope}`}`);
  return data ?? [];
}

export async function publishExpert(manifest: string): Promise<EcoExpert> {
  if (USE_MOCK) {
    const idLine = manifest.split('\n').find((l) => l.startsWith('id:')) ?? 'id: usr.1001.new';
    const displayLine = manifest.split('\n').find((l) => l.startsWith('display:')) ?? 'display: 新专家';
    return {
      id: `eco-${Date.now()}`,
      expert_id: idLine.replace('id:', '').trim(),
      version: '1.0.0',
      display: displayLine.replace('display:', '').trim(),
      summary: 'mock 发布',
      source: 2,
      status: 2,
    };
  }
  return http.post<EcoExpert>('/eco/experts', { manifest });
}

export async function unpublishExpert(id: string): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/eco/experts/${id}/unpublish`, {});
}

export async function deleteExpert(id: string): Promise<void> {
  if (USE_MOCK) return;
  await http.delete(`/eco/experts/${id}`);
}

export async function downloadManifest(id: string): Promise<string> {
  if (USE_MOCK) return mockExperts().find((e) => e.id === id)?.manifest ?? '# 不存在';
  const res = await fetch(`${import.meta.env.VITE_API_BASE ?? 'http://localhost:8080/api/v1'}/eco/experts/${id}/download`);
  return res.text();
}

// ---------------------------------------------------------------------------
// mock 桩
// ---------------------------------------------------------------------------
interface MockRow extends EcoExpert {
  manifest: string;
}

const mockExperts = (): MockRow[] => [
  {
    id: 'eco-1', expert_id: 'corp.code-reviewer', version: '1.2.0', display: '代码评审专家',
    summary: '逐文件审查 diff，输出阻断/建议/风险评级三段结构。', source: 1, status: 2,
    manifest: 'id: corp.code-reviewer\ntype: local\nversion: 1.2.0\ndisplay: 代码评审专家\npersona: |\n  逐文件审查 diff，输出三段结构。\ntools:\n  builtin: [read_file, git_diff]\nsource: company\n',
  },
  {
    id: 'eco-2', expert_id: 'corp.test-writer', version: '1.0.0', display: '测试专家',
    summary: '按变更面生成单测清单与用例骨架。', source: 1, status: 2,
    manifest: 'id: corp.test-writer\ntype: local\nversion: 1.0.0\ndisplay: 测试专家\npersona: |\n  按变更面生成单测清单。\nsource: company\n',
  },
  {
    id: 'eco-3', expert_id: 'usr.1001.weekly-helper', version: '0.3.0', display: '我的周报助手',
    summary: '汇总本周 journal 产出周报初稿。', source: 2, owner_user_id: '1001', status: 2,
    manifest: 'id: usr.1001.weekly-helper\ntype: local\nversion: 0.3.0\ndisplay: 我的周报助手\npersona: |\n  汇总 journal 产出周报。\nsource: personal\n',
  },
];
