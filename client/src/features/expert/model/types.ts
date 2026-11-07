// 专家库类型（D14 §2/§5 eco REST 契约同构）
export interface EcoExpert {
  id: string;
  expert_id: string; // corp.x / usr.{uid}.x
  version: string;
  display: string;
  summary: string;
  source: number; // 1 company 2 personal
  owner_user_id?: string;
  status: number; // 2 published
  created_at?: number;
}
