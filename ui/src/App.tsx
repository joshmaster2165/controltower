import { Fragment, useEffect, useState } from 'react';
import { useStore, type Route } from './store';
import { connectWs, disconnectWs } from './ws';
import { SetupPage, LoginPage } from './pages/Auth';
import { AirspacePage } from './pages/Airspace';
import { FlightsPage } from './pages/Flights';
import { KeysPage } from './pages/Keys';
import { ProvidersPage } from './pages/Providers';
import { ModelsPage } from './pages/Models';
import { PlaygroundPage } from './pages/Playground';
import { TowerPage } from './pages/Tower';
import { McpPage } from './pages/Mcp';
import { HttpApisPage } from './pages/HttpApis';
import { A2aAgentsPage } from './pages/A2aAgents';
import { WelcomePage } from './pages/Welcome';
import { LedgerPage } from './pages/Ledger';
import { AlertsPage, AlertToasts } from './pages/Alerts';
import { ReportPage } from './pages/Report';
import { api } from './api';
import { Icon, type IconName } from './components/Icon';

const NAV: Array<{ group: string; items: Array<{ id: Route; label: string; icon: IconName; hint: string }> }> = [
  {
    group: 'Operate',
    items: [
      { id: 'airspace', label: 'Airspace', icon: 'map', hint: 'The live map of agents, models, tools and gates' },
      { id: 'tower', label: 'Tower', icon: 'tower', hint: 'Requests waiting for a human decision' },
      { id: 'alerts', label: 'Alerts', icon: 'bell', hint: 'Alert inbox, rules and channels' },
    ],
  },
  {
    group: 'Observe',
    items: [
      { id: 'report', label: 'Inventory', icon: 'list', hint: 'Every agent, path and gate — printable' },
      { id: 'ledger', label: 'Ledger', icon: 'chart', hint: 'Spend, tokens and latency' },
      { id: 'flights', label: 'Flights', icon: 'activity', hint: 'Every request through the gateway' },
    ],
  },
  {
    group: 'Configure',
    items: [
      { id: 'providers', label: 'Providers', icon: 'plug', hint: 'LLM provider connections' },
      { id: 'models', label: 'Models', icon: 'cpu', hint: 'Deployments and aliases' },
      { id: 'keys', label: 'Keys', icon: 'key', hint: 'One API key per agent' },
      { id: 'mcp', label: 'MCP servers', icon: 'tool', hint: 'Tool servers agents may reach' },
      { id: 'http', label: 'HTTP APIs', icon: 'globe', hint: 'REST APIs agents call through the gateway' },
      { id: 'a2a', label: 'A2A agents', icon: 'agents', hint: 'Remote agents reached over the A2A protocol' },
    ],
  },
  {
    group: 'Start',
    items: [
      { id: 'welcome', label: 'Get started', icon: 'check', hint: 'Connect a provider and your first agent' },
      { id: 'playground', label: 'Playground', icon: 'play', hint: 'Send a test request' },
    ],
  },
];

function readCollapsed(): boolean {
  try {
    return localStorage.getItem('ct.sidebar.collapsed') === '1';
  } catch {
    return false;
  }
}

const NO_VIEWS: never[] = [];

export function App() {
  const booted = useStore((s) => s.booted);
  const status = useStore((s) => s.status);
  const me = useStore((s) => s.me);
  const route = useStore((s) => s.route);
  const routeParam = useStore((s) => s.routeParam);
  // Select the stored array itself: a fresh `[]` from the selector would re-render forever.
  const views = useStore((s) => s.topology?.views) ?? NO_VIEWS;
  const wsState = useStore((s) => s.wsState);
  const setRoute = useStore((s) => s.setRoute);
  const setMe = useStore((s) => s.setMe);
  const pending = useStore((s) => s.approvals.length);
  const unreadAlerts = useStore((s) => s.unreadAlerts);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    void useStore.getState().boot();
  }, []);

  useEffect(() => {
    if (me?.email) connectWs();
    else disconnectWs();
    return () => disconnectWs();
  }, [me?.email]);

  if (!booted) return <div className="center" style={{ color: 'var(--text-dim)' }}>Loading…</div>;
  if (!status?.setup_complete) return <SetupPage />;
  if (!me?.email) return <LoginPage />;

  const logout = async () => {
    await api.post('/admin/api/logout');
    setMe(null);
  };

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('ct.sidebar.collapsed', c ? '0' : '1');
      } catch {
        /* private mode */
      }
      return !c;
    });
  };

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.svg" alt="" />
          <span className="brand-name">
            Control <span className="accent">Tower</span>
          </span>
        </div>
        <nav className="side-nav" aria-label="Main">
          {NAV.map((g) => (
            <div key={g.group} className="nav-group">
              <div className="nav-group-label">{g.group}</div>
              {g.items.map((n) => {
                const count = n.id === 'tower' ? pending : n.id === 'alerts' && route !== 'alerts' ? unreadAlerts : 0;
                const inView = n.id === 'airspace' && route === 'airspace' && !!routeParam && routeParam !== 'new';
                return (
                  <Fragment key={n.id}>
                  <a
                    href={`#/${n.id}`}
                    className={route === n.id && !inView ? 'active' : ''}
                    title={collapsed ? `${n.label} — ${n.hint}` : n.hint}
                    aria-current={route === n.id && !inView ? 'page' : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      setRoute(n.id);
                    }}
                  >
                    <Icon name={n.icon} size={17} />
                    <span className="nav-label">{n.label}</span>
                    {count > 0 && <span className={`badge ${n.id === 'alerts' ? 'alert' : ''}`}>{count > 99 ? '99+' : count}</span>}
                  </a>
                  {n.id === 'airspace' && !collapsed && (
                    // Views: one part of the organization each, with a map of its own.
                    <div className="nav-sub" aria-label="Airspace views">
                      {views.map((v) => (
                        <a
                          key={v.id}
                          href={`#/airspace/${v.id}`}
                          className={route === 'airspace' && routeParam === v.id ? 'active' : ''}
                          aria-current={route === 'airspace' && routeParam === v.id ? 'page' : undefined}
                          title={`${v.name}: ${v.teams.join(', ')}`}
                          onClick={(e) => {
                            e.preventDefault();
                            setRoute('airspace', v.id);
                          }}
                        >
                          <i style={{ background: v.color }} />
                          <span className="nav-label">{v.name}</span>
                        </a>
                      ))}
                      <a
                        href="#/airspace/new"
                        className="nav-add"
                        title="A map of one part of the organization: pick its teams"
                        onClick={(e) => {
                          e.preventDefault();
                          setRoute('airspace', 'new');
                        }}
                      >
                        <span className="nav-label">+ New view</span>
                      </a>
                    </div>
                  )}
                  </Fragment>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="side-status">
            <span className={`pill ${wsState === 'live' ? 'live' : 'warn'}`} title="Connection to this Control Tower">
              <i className="led" /> <span className="nav-label">{wsState}</span>
            </span>
            {status.mode === 'off' && (
              <span className="pill warn" title="CT_MODE=off: gates are not enforced">
                <i className="led" /> <span className="nav-label">enforcement off</span>
              </span>
            )}
            {status.demo && (
              <button type="button" className="pill demo nav-label" title="Synthetic agents are generating traffic — click to manage" onClick={() => setRoute('welcome')}>
                demo traffic
              </button>
            )}
          </div>
          <div className="side-user">
            <span className="avatar" title={me.email}>
              {me.email.slice(0, 1).toUpperCase()}
            </span>
            <span className="nav-label user-meta">
              <span className="user-email">{me.email}</span>
              <span className="user-version">v{status.version}</span>
            </span>
            <button className="icon-btn" onClick={() => void logout()} title="Sign out" aria-label="Sign out">
              <Icon name="logout" size={16} />
            </button>
          </div>
          <button className="collapse-btn" onClick={toggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand' : 'Collapse'}>
            <Icon name={collapsed ? 'chevrons-right' : 'chevrons-left'} size={15} />
            <span className="nav-label">Collapse</span>
          </button>
        </div>
      </aside>
      <main className={route === 'airspace' ? 'main full' : 'main'}>
        {route === 'airspace' && <AirspacePage />}
        {route === 'tower' && <TowerPage />}
        {route === 'flights' && <FlightsPage />}
        {route === 'keys' && <KeysPage />}
        {route === 'providers' && <ProvidersPage />}
        {route === 'models' && <ModelsPage />}
        {route === 'mcp' && <McpPage />}
        {route === 'http' && <HttpApisPage />}
        {route === 'a2a' && <A2aAgentsPage />}
        {route === 'welcome' && <WelcomePage />}
        {route === 'playground' && <PlaygroundPage />}
        {route === 'ledger' && <LedgerPage />}
        {route === 'alerts' && <AlertsPage />}
        {route === 'report' && <ReportPage />}
      </main>
      <AlertToasts />
    </div>
  );
}
