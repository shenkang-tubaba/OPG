import { ReactNode, useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { AppBrandMark, MenuIcon, SidebarToggleIcon } from '@/components/AppBrand';
import { authApi } from '@/lib/api';
import { authService } from '@/lib/auth-service';
import { useCurrentUser } from '@/lib/hooks/use-api';
import { runtimeContext } from '@/lib/runtime-context';

interface PlatformLayoutProps {
  children: ReactNode;
}

type PlatformNavIconKey =
  | 'dashboard'
  | 'apps'
  | 'runtime'
  | 'jobs'
  | 'notifications'
  | 'login'
  | 'proxy'
  | 'payment'
  | 'sms'
  | 'email'
  | 'storage'
  | 'developer'
  | 'api'
  | 'ai'
  | 'playground'
  | 'sources'
  | 'models'
  | 'usage';

const navItems = [
  {
    key: 'dashboard',
    icon: 'dashboard',
    label: '平台概览',
    desc: '租户规模与运行状态',
    path: '/platform-admin/dashboard',
  },
  {
    key: 'apps',
    icon: 'apps',
    label: '租户应用',
    desc: '画廊视图与租户工作区',
    path: '/platform-admin/apps',
  },
  {
    key: 'runtime',
    icon: 'runtime',
    label: '运行时',
    desc: '模块、模板与注册表',
    path: '/platform-admin/runtime',
  },
  {
    key: 'connectors',
    icon: 'api',
    label: '连接器',
    desc: '自定义上游与动作',
    path: '/platform-admin/connectors',
  },
  {
    key: 'jobs',
    icon: 'jobs',
    label: '任务',
    desc: '后台任务与工作器',
    path: '/platform-admin/jobs',
  },
  {
    key: 'notifications',
    icon: 'notifications',
    label: '通知',
    desc: '告警渠道与投递',
    path: '/platform-admin/notifications',
  },
  {
    key: 'login-credentials',
    icon: 'login',
    label: '登录凭证',
    desc: '微信、GitHub、Google',
    path: '/platform-admin/login-credentials',
  },
  {
    key: 'proxies',
    icon: 'proxy',
    label: '代理 IP',
    desc: '出站代理与检测',
    path: '/platform-admin/proxies',
  },
  {
    key: 'payments',
    icon: 'payment',
    label: '支付方式',
    desc: '支付宝/微信密钥与链路测试',
    path: '/platform-admin/payments',
  },
  {
    key: 'sms',
    icon: 'sms',
    label: '短信服务',
    desc: '短信通道与签名配置',
    path: '/platform-admin/sms',
  },
  {
    key: 'email',
    icon: 'email',
    label: '邮件服务',
    desc: 'Cloudflare 发件与批次',
    path: '/platform-admin/email',
  },
  {
    key: 'storage',
    icon: 'storage',
    label: '对象存储',
    desc: 'OSS、S3 与 R2',
    path: '/platform-admin/storage',
  },
  {
    key: 'developer-authorizations',
    icon: 'developer',
    label: '开发者授权',
    desc: 'SDK、Codex 与 scope',
    path: '/platform-admin/developer-authorizations',
  },
  {
    key: 'apis',
    icon: 'api',
    label: '共享 API 列表',
    desc: '端点与中文说明',
    path: '/platform-admin/apis',
  },
] satisfies Array<{
  key: string;
  icon: PlatformNavIconKey;
  label: string;
  desc: string;
  path: string;
}>;

const platformNavIconPaths: Record<PlatformNavIconKey, string[]> = {
  dashboard: ['M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v4A1.5 1.5 0 0 1 9.5 11h-4A1.5 1.5 0 0 1 4 9.5v-4ZM13 5.5A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13 9.5v-4ZM4 14.5A1.5 1.5 0 0 1 5.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-4ZM13 14.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4Z'],
  apps: ['M12 4 4 8l8 4 8-4-8-4Z', 'M4 12l8 4 8-4', 'M4 16l8 4 8-4'],
  runtime: ['M5 5h14v5H5V5Z', 'M5 14h14v5H5v-5Z', 'M8 7.5h.01M8 16.5h.01M11 7.5h5M11 16.5h5'],
  jobs: ['M7 6h10', 'M7 12h10', 'M7 18h10', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  notifications: ['M18 9a6 6 0 0 0-12 0c0 7-2 7-2 8h16c0-1-2-1-2-8Z', 'M10 20h4', 'M9 4a3 3 0 0 1 6 0'],
  login: ['M15 7.5V6a3 3 0 0 0-6 0v1.5', 'M7 10h10a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 17 19H7a1.5 1.5 0 0 1-1.5-1.5v-6A1.5 1.5 0 0 1 7 10Z', 'M12 14v2'],
  proxy: ['M8 8h8a4 4 0 0 1 0 8h-2', 'M16 16H8a4 4 0 0 1 0-8h2', 'M9 12h6'],
  payment: ['M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v9A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5v-9Z', 'M4 10h16', 'M7 15h4'],
  sms: ['M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H11l-4.5 4v-4A2.5 2.5 0 0 1 4 12.5v-6Z', 'M8 8h8M8 11h5'],
  email: ['M4 7.5 12 13l8-5.5', 'M6 18h12A2 2 0 0 0 20 16V8A2 2 0 0 0 18 6H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2Z'],
  storage: ['M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Z', 'M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7', 'M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5'],
  developer: ['M12 4v4', 'M8 8h8l2 4-6 8-6-8 2-4Z', 'M9 12h6'],
  api: ['M8 7 4 12l4 5', 'M16 7l4 5-4 5', 'M14 4l-4 16'],
  ai: ['M13 3 5 14h6l-1 7 9-12h-6l0-6Z'],
  playground: ['M12 3l1.9 5.9H20l-5 3.6 1.9 5.9-5-3.6-5 3.6L8.8 12.5l-5-3.6h6.2L12 3Z'],
  sources: ['M5 7a4 4 0 0 1 7-2.65A4 4 0 1 1 12 11H8', 'M19 17a4 4 0 0 1-7 2.65A4 4 0 1 1 12 13h4'],
  models: ['M12 4 4 8l8 4 8-4-8-4Z', 'M4 12l8 4 8-4', 'M4 16l8 4 8-4'],
  usage: ['M6 17v-5', 'M12 17V7', 'M18 17v-8'],
};

function PlatformNavIcon({ icon }: { icon: PlatformNavIconKey }) {
  return (
    <span className="platform-nav-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        {platformNavIconPaths[icon].map((path) => (
          <path key={path} d={path} />
        ))}
      </svg>
    </span>
  );
}

const navigationGroups = [
  { label: '平台', keys: ['dashboard', 'apps'] },
  { label: 'AI 与接口', keys: ['playground', 'sources', 'models', 'usage', 'connectors', 'apis', 'developer-authorizations'] },
  { label: '服务', keys: ['login-credentials', 'payments', 'sms', 'email', 'storage'] },
  { label: '运维', keys: ['runtime', 'jobs', 'observability', 'notifications', 'proxies'] },
];
const allNavigationItems = [...navItems,
  { key: 'playground', icon: 'playground', label: 'Playground', desc: '调试 AI 模型', path: '/platform-admin/ai/playground' },
  { key: 'sources', icon: 'sources', label: '供应商', desc: 'AI 来源与连通性', path: '/platform-admin/ai/sources' },
  { key: 'models', icon: 'models', label: '模型', desc: '模型目录与路由', path: '/platform-admin/ai/models' },
  { key: 'usage', icon: 'usage', label: '调用统计', desc: 'AI 用量与日志', path: '/platform-admin/ai/usage' },
  { key: 'observability', icon: 'usage', label: '可观测性', desc: '请求与审计事件', path: '/platform-admin/observability' },
] satisfies Array<{ key: string; icon: PlatformNavIconKey; label: string; desc: string; path: string }>;

export default function PlatformLayout({ children }: PlatformLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: userInfo } = useCurrentUser();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const isTenantWorkspace = !runtimeContext.isPlatformPortal || /^\/platform-admin\/apps\/[^/]+(?:\/|$)/.test(location.pathname);
  const currentPage = allNavigationItems.find(item => location.pathname.startsWith(item.path))?.label || '管理台';
  const visibleGroups = navigationGroups.map(group => ({ ...group, items: group.keys
    .map(key => allNavigationItems.find(item => item.key === key)!)
    .filter(item => `${item.label} ${item.desc}`.toLowerCase().includes(query.trim().toLowerCase()))
  })).filter(group => group.items.length);

  useEffect(() => { setMobileOpen(false); }, [location.pathname, location.search]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileOpen(false); };
    const desktop = window.matchMedia('(min-width: 901px)');
    const onResize = () => { if (desktop.matches) setMobileOpen(false); };
    window.addEventListener('keydown', onKey);
    desktop.addEventListener('change', onResize);
    return () => { window.removeEventListener('keydown', onKey); desktop.removeEventListener('change', onResize); };
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const panel = document.getElementById('opg-platform-navigation');
    const items = () => Array.from(panel?.querySelectorAll<HTMLElement>('button, input, a[href]') || []).filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible');
    const focusInside = () => {
      if (!panel?.contains(document.activeElement)) (items()[0] || panel)?.focus();
    };
    focusInside();
    const focusFrame = requestAnimationFrame(focusInside);
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel?.contains(event.target)) focusInside();
    };
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const targets = items();
      const first = targets[0], last = targets[targets.length - 1];
      const outside = !panel?.contains(document.activeElement);
      if (!first) { event.preventDefault(); panel?.focus(); return; }
      if (outside || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    document.addEventListener('focusin', onFocus);
    panel?.addEventListener('transitionend', focusInside);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', trap);
      document.removeEventListener('focusin', onFocus);
      panel?.removeEventListener('transitionend', focusInside);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [mobileOpen]);
  const handleLogout = () => {
    authApi.logout();
    authService.logout();
    navigate(runtimeContext.loginPath);
  };

  // 全局主题切换（暗色/亮色；main.tsx 启动时已恢复，这里读写同一 localStorage key）
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark') ? 'dark' : 'light',
  );
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('opg-theme', next); } catch { /* ignore */ }
  };

  return (
    <div className={`platform-shell opg-admin ${isTenantWorkspace ? 'tenant-workspace-mode' : ''} ${collapsed ? 'opg-nav-collapsed' : ''}`}>
      {!isTenantWorkspace && <>
        <aside tabIndex={-1} id="opg-platform-navigation" className={`platform-sidebar opg-sidebar ${mobileOpen ? 'open' : ''}`}>
          <div className="opg-sidebar-brand">
            <AppBrandMark size={30} />
            <strong className="opg-brand-name">OPG</strong>
            <button className="opg-icon-button opg-collapse-button" type="button" aria-label={collapsed ? '展开导航' : '收起导航'} aria-expanded={!collapsed} onClick={() => { setCollapsed(value => !value); setQuery(''); }}><SidebarToggleIcon collapsed={collapsed} /></button>
            <button className="opg-icon-button opg-mobile-close" type="button" aria-label="关闭导航" onClick={() => setMobileOpen(false)}><SidebarToggleIcon /></button>
          </div>
          <label className="opg-nav-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg>
            <input type="search" aria-label="查找菜单" placeholder="查找菜单" value={query} onChange={event => setQuery(event.target.value)} />
          </label>
          <nav className="opg-navigation" aria-label="平台导航">
            {visibleGroups.map(group => <div className="opg-nav-section" key={group.label}>
              <h3>{group.label}</h3>
              {group.items.map(item => <NavLink key={item.key} to={item.path} title={item.label} className={({ isActive }) => `opg-nav-link ${isActive ? 'active' : ''}`} onClick={() => setMobileOpen(false)}>
                <PlatformNavIcon icon={item.icon} /><span>{item.label}</span>
              </NavLink>)}
            </div>)}
            {!visibleGroups.length && <p className="opg-nav-empty" role="status">没有匹配的菜单</p>}
          </nav>
          <div className="opg-sidebar-footer"><span>one person group</span><small>v{__APP_VERSION__}</small></div>
        </aside>
        {mobileOpen && <button className="platform-mask" type="button" aria-label="关闭导航菜单" onClick={() => setMobileOpen(false)} />}
      </>}
      <div className={`platform-main ${isTenantWorkspace ? 'tenant-workspace-mode' : ''}`}>
        <header className="platform-header">
          <div className="opg-header-start">
            {!isTenantWorkspace && <button aria-label="打开导航菜单" aria-controls="opg-platform-navigation" aria-expanded={mobileOpen} className="opg-icon-button opg-mobile-menu" type="button" onClick={() => setMobileOpen(value => !value)}><MenuIcon /></button>}
            <div className="opg-breadcrumb"><span>OPG</span><span aria-hidden="true">/</span><strong>{isTenantWorkspace ? '应用工作区' : currentPage}</strong></div>
          </div>
          <div className="platform-header-user">
            <div className="platform-header-user-info"><strong>{userInfo?.display_name || userInfo?.email || '超级管理员'}</strong></div>
            <button
              className="theme-toggle"
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
              title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <button className="btn btn-secondary btn-sm" type="button" onClick={handleLogout}>退出登录</button>
          </div>
        </header>
        <main className="platform-content">{children}</main>
      </div>
    </div>
  );
}
