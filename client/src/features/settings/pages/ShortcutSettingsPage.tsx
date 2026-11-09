/**
 * 设置 · 快捷键（D01 §9 总表渲染 / EXECUTION-PLAN D14）：
 * v0.1 =权威速查表（只读）——键位为 D01 §9 全局冻结约定（Cmd/Ctrl+K 全局搜索、
 * Cmd/Ctrl+Shift+. Agent 紧急停止等），自定义键位映射随全局快捷键框架阶段二
 * （当前各组件 onKeyDown 硬编码消费；框架化后本页开放改键+冲突检测，登记）。
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';
const ALT = isMac ? '⌥' : 'Alt';

/** D01 §9 权威总表（作用域列 v0.1 补充说明） */
const SHORTCUTS: Array<{ keys: string; label: string; scope: string; implemented?: boolean }> = [
  { keys: `${MOD} + K`, label: '全局搜索（跨消息/文档/知识库/联系人）', scope: '全局', implemented: false },
  { keys: `${MOD} + F`, label: '当前会话内搜索', scope: '会话', implemented: true },
  { keys: `${ALT} + ↑/↓`, label: '上/下一个会话（有未读优先）', scope: 'IM 列表', implemented: false },
  { keys: `${MOD} + ,`, label: '打开设置', scope: '全局', implemented: false },
  { keys: `Esc`, label: '逐层关闭浮层（弹窗→抽屉→搜索）', scope: '全局', implemented: true },
  { keys: `${MOD} + ⇧ + .`, label: 'Agent 紧急停止（全局生效）', scope: '全局', implemented: true },
  { keys: `Enter / ⇧+Enter`, label: '发送 / 换行（会话输入框）', scope: '输入框', implemented: true },
];

export function ShortcutSettingsPage() {
  return (
    <div className="settings-section" data-testid="settings-shortcuts">
      <h2 className="settings-section__title">快捷键</h2>

      <div className="settings-card">
        <div className="settings-row__desc" style={{ paddingBottom: 8 }}>
          以下为 D01 §9 全局冻结键位；自定义改键随全局快捷键框架开放（各组件散落
          onKeyDown 收敛为统一注册表后本页开放改键+冲突检测）。
        </div>
        <table className="settings-shortcut-table" data-testid="shortcut-table">
          <thead>
            <tr>
              <th>键位</th>
              <th>作用</th>
              <th>作用域</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys} data-testid="shortcut-row">
                <td>
                  <kbd className="settings-kbd">{s.keys}</kbd>
                </td>
                <td>{s.label}</td>
                <td>{s.scope}</td>
                <td>{s.implemented ? <span className="tag tag--builtin">已生效</span> : <span className="tag">规划中</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
