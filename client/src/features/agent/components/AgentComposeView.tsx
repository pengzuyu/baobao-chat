/**
 * 新建会话页（/agent/new，2026-11-23 用户裁决：懒创建——ZCode 同款）：
 * - 点击「新建」只进入本页（居中输入框），**不创建会话**；真正发送首条消息时才
 *   createSession 落库——避免占位空会话堆积（runtime 无删除命令）与 8001 名额占用
 * - 上下文差异（用户口径）：项目新建会话（?workspace=目录）页上显示「所属项目」；
 *   任务新建会话不显示任何项目信息
 * - 重复点击天然幂等：入口均 navigate 到同一路由，本页无任何创建副作用
 * - 权限模式为本页草稿态（模式默认档=自主，单源 DEFAULT_PERMISSION_MODE）、模型草稿取本地
 *   常用模型（2026-11-26 选择即记住：初值=常用值，选择同步落盘）；首建生效；会话建立后由
 *   store setMode/switchModel 接管，
 *   控件与会话视图同款（Dropdown+ModelThinkPicker，full-auto 二次确认）
 * - 发送链路：createSession（store 置 activeSessionId+头插列表）→ void sendText
 *   （origin='workbench' 乐观上屏+首条消息派生标题；sendTextTo 恒 origin='im' 勿用）
 *   → navigate /agent/s/:id；失败（bbrt 缺失/8001 超限等）停留本页 Alert 提示
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Dropdown, Flex, Modal, Typography, theme, type MenuProps } from 'antd';
import { FolderOpen, ShieldCheck } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { useAgentStore } from '../store/agent';
import { AGENT_MODE_OPTIONS, DEFAULT_PERMISSION_MODE } from '../bridge/types';
import type { AttachmentPayload, PermissionMode } from '../bridge/types';
import { ModelThinkPicker } from './ModelThinkPicker';
import { Composer } from './Composer';
import { DEFAULT_MODEL_KEY } from '../utils/modelPref';
import { displayPath } from '../utils/displayPath';
import type { PluginCommand } from '../../eco/api/plugins';
import type { ModelProviders } from '../utils/modelPref';

interface AgentComposeViewProps {
  /** 工作目录（项目会话=绝对路径；''=任务会话，页上不显示所属项目） */
  workspace: string;
  /** 模型选项（公司级 shared + 我的 BYOK；页面层拉取后注入） */
  aiProviders: ModelProviders;
  /** 插件斜杠命令表（/ 唤起；空表=功能关闭） */
  pluginCommands: PluginCommand[];
}

export function AgentComposeView({ workspace, aiProviders, pluginCommands }: AgentComposeViewProps) {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const createSession = useAgentStore((s) => s.createSession);
  const sendText = useAgentStore((s) => s.sendText);
  const workspaces = useAgentStore((s) => s.workspaces);

  // 权限模式/模型=本页草稿态：随 createSession 落到新会话（模式默认档=自主）。
  // 模型草稿初值=本地常用模型（2026-11-26 选择即记住：'default'=公司默认档 /
  // 'p:<id>:<model>'=直达引用）；常用值被失效自愈改写时草稿跟随，用户手选后不再覆盖
  const [mode, setMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE);
  const modelPref = useAgentStore((s) => s.modelPref);
  const setModelPref = useAgentStore((s) => s.setModelPref);
  const [modelChoice, setModelChoice] = useState<string>(modelPref);
  const [modelTouched, setModelTouched] = useState(false);
  useEffect(() => {
    if (!modelTouched) setModelChoice(modelPref);
  }, [modelPref, modelTouched]);
  const [sending, setSending] = useState(false);
  // 同步防重入（state 更新滞后一帧：Enter+按钮连点会各建一个会话）
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);

  /** 模式切换草稿（full-auto 二次确认口径与会话视图一致，文案改为「新会话将以该模式创建」） */
  const doSetMode = useCallback(
    (next: PermissionMode) => {
      if (next === mode) return;
      if (next === 'full-auto') {
        const option = AGENT_MODE_OPTIONS.find((m) => m.value === next);
        Modal.confirm({
          title: '切换到完全控制模式？',
          content: `${option?.desc ?? ''}。新会话将以该模式创建；进入会话后可随时调整。`,
          okText: '切换',
          cancelText: '取消',
          onOk: () => setMode(next),
        });
        return;
      }
      setMode(next);
    },
    [mode],
  );

  const modeMenu: MenuProps = {
    items: AGENT_MODE_OPTIONS.map((m) => ({
      key: m.value,
      label: (
        <div>
          <div>{m.label}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {m.desc}
          </Typography.Text>
        </div>
      ),
    })),
    onClick: ({ key }) => doSetMode(key as PermissionMode),
  };

  /** 模型选择草稿：'default'=公司默认档 / p:<id>:<model>=直达引用；选择即记住（落常用值） */
  const onSelectModel = useCallback(
    (key: string) => {
      setModelTouched(true);
      setModelChoice(key);
      setModelPref(key);
    },
    [setModelPref],
  );

  /** 懒创建发送：此刻才建会话 → 乐观上屏+派生标题 → 跳会话视图（底部输入框形态）。
   *  回 true=已发出；false=建会话失败（停留本页报错，Composer 还原输入原文） */
  const doSend = useCallback(
    async (text: string, attachments?: AttachmentPayload[]): Promise<boolean> => {
      if (sendingRef.current) return false;
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      try {
        // 模型草稿：公司默认=显式 null（本页草稿即最终选择，不再叠常用值）；
        // 直达引用原样透传（选项来自当前供应商清单）
        const meta = await createSession({
          workspace,
          mode,
          model: modelChoice === DEFAULT_MODEL_KEY ? null : modelChoice,
        });
        void sendText(text, attachments); // createSession 已置 activeSessionId；同步段先乐观上屏再跳转
        navigate(`/agent/s/${meta.id}`);
        return true;
      } catch (err: unknown) {
        sendingRef.current = false;
        setSending(false);
        setSendError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [modelChoice, workspace, mode, createSession, sendText, navigate],
  );

  const modeOption = AGENT_MODE_OPTIONS.find((m) => m.value === mode);
  // 项目名：登记表优先，兜底路径末段（兼容 Windows 反斜杠）；任务会话（workspace=''）不渲染该行
  const projectName = workspace
    ? (workspaces.find((w) => w.path === workspace)?.name ?? workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace)
    : null;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: 24,
        overflowY: 'auto',
      }}
    >
      {workspace && projectName ? (
        <Flex align="center" gap={6} title={displayPath(workspace)} style={{ color: token.colorTextSecondary, fontSize: 13, maxWidth: '100%' }}>
          <FolderOpen size={14} aria-hidden />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>所属项目 · {projectName}</span>
        </Flex>
      ) : null}
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        向 Agent 描述一个任务试试（支持文件定位、命令执行与审批）
      </Typography.Text>
      <div style={{ width: '100%', maxWidth: 760 }}>
        {sendError ? <Alert type="error" showIcon message={sendError} style={{ marginBottom: 12 }} /> : null}
        <Composer
          centered
          autoFocus
          disabled={sending}
          disabledHint="正在创建会话…"
          canStop={false}
          onSend={doSend}
          onStop={() => undefined}
          commands={pluginCommands}
          modePicker={
            <Dropdown menu={modeMenu} trigger={['click']}>
              <Button variant="secondary" size="small" icon={<ShieldCheck size={13} aria-hidden />} title="选择权限模式（新会话生效）">
                {modeOption?.label ?? mode}
              </Button>
            </Dropdown>
          }
          modelPicker={<ModelThinkPicker providers={aiProviders} value={modelChoice} onSelect={onSelectModel} />}
        />
      </div>
    </div>
  );
}
