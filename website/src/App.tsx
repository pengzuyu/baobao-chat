/**
 * BaobaoChat 官网单页（D21）：产品介绍 / 功能特性 / 路线图 / 下载区。
 * 下载区数据运行时拉取 /update/release-info.json（发布脚本产物）——
 * 发新版自动跟进；文案初稿源=README/docs 00/EXECUTION-PLAN，业务方终审后可改。
 */

import { useEffect, useState } from 'react';
import {
  loadReleaseInfo,
  groupDownloads,
  formatSize,
  formatDate,
  type ReleaseInfo,
} from './release';

// ── 功能特性（现状已落地能力；口径与 docs/00 一致）──
const FEATURES: { title: string; desc: string; tag: string }[] = [
  {
    title: 'IM 即时通讯',
    desc: '单聊 / 群聊、消息编辑撤回与转发、已读回执、收藏、表情包、通知中心与多端同步。',
    tag: '协作',
  },
  {
    title: 'AI Agent 工作台',
    desc: '项目 / 日常双区管理；完整过程透明（思考 · 工具 · 结论）；三档权限模式与审批卡、提问卡；子代理三形态与本地编码智能体（zcode 等）委派。',
    tag: 'Agent',
  },
  {
    title: 'IM 内嵌 Agent 卡',
    desc: '聊天会话里直接发起 Agent：过程实时落流、跨端审批同步、结论沉淀为消息记录。',
    tag: 'Agent',
  },
  {
    title: 'Agent 记忆与日报',
    desc: '用户级 / 项目级分级记忆，工具教训与会话提炼自动沉淀；活动日志生成确定性日报。',
    tag: 'Agent',
  },
  {
    title: '知识库',
    desc: '个人 / 部门 / 公司三级空间，文档摄入管线与权限过滤检索，为 Agent 提供可信上下文。',
    tag: '知识',
  },
  {
    title: '企业邮箱',
    desc: '私有化邮件栈与统一身份对接，收发信、写信与设置一体（持续完善中）。',
    tag: '办公',
  },
  {
    title: '生态应用与技能',
    desc: '应用商店与技能分发：生态应用注册上架、技能安装，Agent 专家库的供给通道。',
    tag: '生态',
  },
  {
    title: '管理后台',
    desc: '组织 / 用户 / 角色 / 策略 / 审计 / 用量一体化治理；AI 供应商与模型路由统一管理。',
    tag: '治理',
  },
  {
    title: '安全内建',
    desc: '端侧沙箱（Seatbelt / bwrap 分层防御）、工具权限分级、AI 网关作为模型流量唯一出入口。',
    tag: '安全',
  },
];

// ── 路线图（不挂已裁决关闭项：移动端 / 外网接入 / 音视频会议）──
const ROADMAP: { phase: string; title: string; items: string[] }[] = [
  {
    phase: '近期',
    title: '发布链路与真机验收',
    items: [
      '官网与三平台自动更新上线（macOS 双架构 / Linux / Windows）',
      '首版真机走查收尾：更新升级、生产网关链路、双端体验',
      'Windows 平台安装包联调验证',
    ],
  },
  {
    phase: '中期',
    title: '发布工程化',
    items: [
      '发布流水线 CI 化：三平台矩阵构建、产物签名与发布一键化',
      '灰度发布与版本回退演练',
      '更新源高可用与分发带宽优化',
    ],
  },
  {
    phase: '远期',
    title: 'Agent 能力深化',
    items: [
      '专家库与个人 MCP 面板完善',
      '知识库检索与摄入管线增强',
      '邮箱体验与办公协同场景打磨',
    ],
  },
];

function Header() {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <div className="brand">
          <span className="brand-mark">B</span>
          <span className="brand-name">BaobaoChat</span>
        </div>
        <nav className="site-nav">
          <a href="#features">功能特性</a>
          <a href="#roadmap">路线图</a>
          <a href="#download" className="nav-cta">
            下载
          </a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero">
      <div className="container">
        <h1>
          让协作更简单
          <br />
          <span className="hero-accent">企业级多 Agent 协作工作台</span>
        </h1>
        <p className="hero-sub">
          聊天 · 文件 · 邮件 · 知识库 · 专家 Agent · Agent 插件 —— 私有化部署，数据留在公司内网。
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary" href="#download">
            下载桌面客户端
          </a>
          <a className="btn btn-ghost" href="#features">
            了解功能
          </a>
        </div>
        <p className="hero-note">桌面端：macOS（双架构）· Linux · Windows ｜ 应用内自动更新</p>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="section">
      <div className="container">
        <h2 className="section-title">功能特性</h2>
        <p className="section-sub">当前版本已落地的核心能力</p>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="feature-card">
              <span className="feature-tag">{f.tag}</span>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Roadmap() {
  return (
    <section id="roadmap" className="section section-alt">
      <div className="container">
        <h2 className="section-title">路线图</h2>
        <p className="section-sub">我们正在建设的方向</p>
        <div className="roadmap-grid">
          {ROADMAP.map((r) => (
            <div key={r.title} className="roadmap-card">
              <span className="roadmap-phase">{r.phase}</span>
              <h3>{r.title}</h3>
              <ul>
                {r.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DownloadSection() {
  const [info, setInfo] = useState<ReleaseInfo | null | 'loading'>('loading');

  useEffect(() => {
    let alive = true;
    void loadReleaseInfo().then((r) => {
      if (alive) setInfo(r);
    });
    return () => {
      alive = false;
    };
  }, []);

  const groups = info && info !== 'loading' ? groupDownloads(info) : [];

  return (
    <section id="download" className="section">
      <div className="container">
        <h2 className="section-title">下载</h2>
        <p className="section-sub">
          {info && info !== 'loading' ? (
            <>
              最新版本 <strong>v{info.version}</strong>
              {info.date ? ` · ${formatDate(info.date)} 发布` : ''}
            </>
          ) : (
            '获取各平台安装包'
          )}
        </p>

        {info === 'loading' ? (
          <div className="download-placeholder">正在获取版本信息…</div>
        ) : info === null ? (
          <div className="download-placeholder">
            暂未发布安装包 —— 版本发布后此处将自动展示各平台下载入口。
          </div>
        ) : (
          <>
            <div className="download-grid">
              {groups.map((g) => (
                <div key={g.key} className={`download-card${g.current ? ' download-card--current' : ''}`}>
                  <div className="download-card__head">
                    <h3>{g.title}</h3>
                    {g.current ? <span className="download-badge">推荐</span> : null}
                  </div>
                  <p className="download-hint">{g.hint}</p>
                  <ul className="download-files">
                    {g.items.map((d) => (
                      <li key={d.file}>
                        <a href={d.url} download>
                          {d.file}
                        </a>
                        <span className="download-meta">
                          {formatSize(d.size)}
                          {d.autoUpdate ? ' · 支持应用内更新' : ' · 手动升级'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {info.notes ? (
              <details className="release-notes">
                <summary>v{info.version} 更新说明</summary>
                <pre>{info.notes}</pre>
              </details>
            ) : null}
            <p className="download-verify">
              安装包均附 minisign 签名（客户端自动校验）；校验和见各文件 sha256，
              可在下载后自行核对。旧版本安装后启动即提示自动更新，无需手动重装。
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-inner">
          <span>© {new Date().getFullYear()} BaobaoChat · 企业协作工作台</span>
          <span>私有化部署 · 数据留在内网 · 内部使用</span>
        </div>
      </div>
    </footer>
  );
}

export function App() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <Features />
        <Roadmap />
        <DownloadSection />
      </main>
      <Footer />
    </>
  );
}
