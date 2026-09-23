import { useEffect } from 'react';
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
import { LedgerPage } from './pages/Ledger';
import { AlertsPage, AlertToasts } from './pages/Alerts';
import { ReportPage } from './pages/Report';
import { api } from './api';

const NAV: Array<{ id: Route; label: string }> = [
  { id: 'airspace', label: 'Airspace' },
  { id: 'tower', label: 'Tower' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'report', label: 'Inventory' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'flights', label: 'Flights' },
  { id: 'keys', label: 'Keys' },
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  { id: 'mcp', label: 'MCP' },
  { id: 'playground', label: 'Playground' },
];

export function App() {
  const booted = useStore((s) => s.booted);
  const status = useStore((s) => s.status);
  const me = useStore((s) => s.me);
  const route = useStore((s) => s.route);
  const wsState = useStore((s) => s.wsState);
  const setRoute = useStore((s) => s.setRoute);
  const setMe = useStore((s) => s.setMe);
  const pending = useStore((s) => s.approvals.length);
  const unreadAlerts = useStore((s) => s.unreadAlerts);

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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img src="/logo.svg" alt="" /> Control <span className="accent">Tower</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={route === n.id ? 'active' : ''} onClick={(e) => { e.preventDefault(); setRoute(n.id); }}>
              {n.label}
              {n.id === 'tower' && pending > 0 && <span className="badge">{pending}</span>}
              {n.id === 'alerts' && unreadAlerts > 0 && route !== 'alerts' && <span className="badge alert">{unreadAlerts > 99 ? '99+' : unreadAlerts}</span>}
            </a>
          ))}
        </nav>
        <div className="spacer" />
        {status.demo && <span className="pill demo">demo traffic</span>}
        {status.mode === 'off' && <span className="pill warn"><i className="led" /> enforcement off</span>}
        <span className={`pill ${wsState === 'live' ? 'live' : 'warn'}`}>
          <i className="led" /> {wsState}
        </span>
        <span className="pill">v{status.version}</span>
        <button className="btn sm ghost" onClick={() => void logout()}>
          Sign out
        </button>
      </header>
      <main style={{ minHeight: 0, overflow: route === 'airspace' ? 'hidden' : 'auto' }}>
        {route === 'airspace' && <AirspacePage />}
        {route === 'tower' && <TowerPage />}
        {route === 'flights' && <FlightsPage />}
        {route === 'keys' && <KeysPage />}
        {route === 'providers' && <ProvidersPage />}
        {route === 'models' && <ModelsPage />}
        {route === 'mcp' && <McpPage />}
        {route === 'playground' && <PlaygroundPage />}
        {route === 'ledger' && <LedgerPage />}
        {route === 'alerts' && <AlertsPage />}
        {route === 'report' && <ReportPage />}
      </main>
      <AlertToasts />
    </div>
  );
}
