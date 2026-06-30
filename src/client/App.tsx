import React, { useEffect, useMemo, useRef, useState } from 'react';

import type {
  AuthStatusResponse,
  CabinsResponse,
  DiagnosticsStateResponse,
  FarmhandsResponse,
  HealthResponse,
  InviteCodeResponse,
  PlayersResponse,
  RenderingStatus,
  ServerStatus,
  SettingsResponse,
  StatsResponse,
} from '../shared/junimo';

import { AppLayout } from './components/Layout';
import { ChatWidget } from './components/ChatWidget';
import { Modal } from './components/Modal';
import { CopyButton } from './components/CopyButton';
import { ToastContainer, type ToastMessage } from './components/Toast';
import { MapView } from './components/MapView';


type SessionPayload = {
  authenticated: boolean;
  csrfToken: string | null;
  expiresAt: number | null;
};

type DashboardPayload = {
  status: ServerStatus;
  players: PlayersResponse;
  inviteCode: InviteCodeResponse;
  health: HealthResponse;
  stats: StatsResponse;
  farmhands: FarmhandsResponse;
  settings: SettingsResponse;
  cabins: CabinsResponse;
  rendering: RenderingStatus;
  screenshot: {
    success: boolean;
    base64Png?: string | null;
    width?: number;
    height?: number;
    error?: string | null;
  };
  auth: AuthStatusResponse;
  diagnostics: DiagnosticsStateResponse | null;
};

type AppConfigLegacy = {
  appName?: string;
  documentationUrl?: string;
  secureProxy?: boolean;
  baseUrlHint?: string;
  defaultMapApiBaseUrl?: string;
};

// Assuming __JUNIMO_WEB_CONFIG__ is injected by the entrypoint.
const appConfig: AppConfigLegacy = (window as any).__JUNIMO_WEB_CONFIG__ || {};

async function api<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  let payload: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!response.ok) {
    const message =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

function fmtTimeOfDay(value: number): string {
  if (!value) {
    return 'Unknown';
  }
  const padded = value.toString().padStart(4, '0');
  const hours = Number.parseInt(padded.slice(0, 2), 10) % 24;
  const minutes = Number.parseInt(padded.slice(2), 10);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) {
    return iso;
  }
  const deltaMs = Date.now() - ts;
  const deltaSec = Math.round(deltaMs / 1000);
  if (Math.abs(deltaSec) < 60) {
    return `${deltaSec}s ago`;
  }
  const deltaMin = Math.round(deltaSec / 60);
  if (Math.abs(deltaMin) < 60) {
    return `${deltaMin}m ago`;
  }
  const deltaHour = Math.round(deltaMin / 60);
  return `${deltaHour}h ago`;
}

function metricTone(ok: boolean, warn = false): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (ok) return 'ok';
  if (warn) return 'warn';
  return 'bad';
}

function screenshotUrl(base64Png?: string | null): string | null {
  if (!base64Png) {
    return null;
  }
  return `data:image/png;base64,${base64Png}`;
}

export function App() {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [password, setPassword] = useState('');
    const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, type, message }]);
  };

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [chatConnected, setChatConnected] = useState(false);
  const [chatLines, setChatLines] = useState<Array<{ type: string; text: string }>>([]);
  const [chatAuthor, setChatAuthor] = useState('AdminConsole');
  const [chatMessage, setChatMessage] = useState('');
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [activeModal, setActiveModal] = useState<string | null>(null);
  
  const [performanceHistory, setPerformanceHistory] = useState({
    tps: [] as number[],
    memory: [] as number[],
    avgTick: [] as number[]
  });

  const [forms, setForms] = useState({
    authTimeout: '600',
    renderingFps: '15',
    timeOfDay: '1200',
    clockSpeed: '1',
    grantAdminName: '',
    grantAdminId: '',
    deleteFarmhandName: '',
    deleteFarmhandId: '',
    deleteConfirm: '',
    reloadConfirm: '',
    newGameConfirm: '',
    newGameFarmType: '0',
    newGameFarmName: '',
    newGameStartingCabins: '1',
    newGameCabinStrategy: 'CabinStack',
    newGameMaxPlayers: '8',
    newGameProfitMargin: '1',
    newGameSeparateWallets: false,
    mapApiUrl: localStorage.getItem('junimo_map_api_url') || appConfig.defaultMapApiBaseUrl || 'http://localhost:8080'
  });
  const chatSocketRef = useRef<WebSocket | null>(null);

  const screenshotSrc = useMemo(() => screenshotUrl(dashboard?.screenshot.base64Png), [dashboard]);

  async function refreshData(nextIncludeDiagnostics = includeDiagnostics) {
    const nextSession = await api<SessionPayload>('/api/auth/session');
    setSession(nextSession);
    if (!nextSession.authenticated) {
      setDashboard(null);
      setLoading(false);
      return;
    }

    const nextDashboard = await api<DashboardPayload>(
      `/api/dashboard?diagnostics=${nextIncludeDiagnostics ? 'true' : 'false'}`,
    );
    setDashboard(nextDashboard);
    
    setPerformanceHistory(prev => {
      const keep = 30;
      return {
        tps: [...prev.tps, nextDashboard.stats.tps].slice(-keep),
        memory: [...prev.memory, nextDashboard.stats.memoryMb].slice(-keep),
        avgTick: [...prev.avgTick, nextDashboard.stats.avgTickMs].slice(-keep),
      };
    });
    
    setLoading(false);
  }

  useEffect(() => {
    refreshData().catch((reason: unknown) => {
      addToast(reason instanceof Error ? reason.message : 'Failed to load', 'error');
      setLoading(false);
    });

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshData().catch(console.error);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!session?.authenticated || !session.csrfToken) {
      if (chatSocketRef.current) {
        chatSocketRef.current.close();
        chatSocketRef.current = null;
      }
      setChatConnected(false);
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    chatSocketRef.current = socket;

    socket.addEventListener('open', () => {
      setChatConnected(true);
      setChatLines((current) => [...current.slice(-19), { type: 'system', text: 'Chat bridge connected' }]);
    });
    socket.addEventListener('close', () => {
      setChatConnected(false);
      setChatLines((current) => [...current.slice(-19), { type: 'system', text: 'Chat bridge disconnected' }]);
    });
    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data as string) as {
          type?: string;
          payload?: { playerName?: string; message?: string; error?: string };
        };
        if (payload.type === 'chat') {
          setChatLines((current) => [
            ...current.slice(-49),
            {
              type: 'chat',
              text: `${payload.payload?.playerName ?? 'Unknown'}: ${payload.payload?.message ?? ''}`,
            },
          ]);
          return;
        }
        if (payload.type === 'auth_success') {
          setChatLines((current) => [...current.slice(-49), { type: 'system', text: 'Junimo WebSocket authenticated' }]);
          return;
        }
        if (payload.type === 'auth_failed') {
          setChatLines((current) => [
            ...current.slice(-49),
            { type: 'error', text: payload.payload?.error ?? 'Upstream auth failed' },
          ]);
          return;
        }
        if (payload.type === 'error') {
          setChatLines((current) => [
            ...current.slice(-49),
            { type: 'error', text: payload.payload?.error ?? 'Unknown chat error' },
          ]);
        }
      } catch {
        setChatLines((current) => [...current.slice(-49), { type: 'system', text: String(event.data) }]);
      }
    });

    return () => {
      socket.close();
    };
  }, [session?.authenticated, session?.csrfToken]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const nextSession = await api<SessionPayload>('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      });
      setSession(nextSession);
      setPassword('');
      await refreshData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Login failed');
      setLoading(false);
    }
  }

  async function logout() {
    if (!session?.csrfToken) {
      return;
    }
    try {
      await api('/api/auth/logout', {
        method: 'POST',
        headers: {
          [ 'x-csrf-token' ]: session.csrfToken,
        },
      });
      setSession({ authenticated: false, csrfToken: null, expiresAt: null });
      setDashboard(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Logout failed');
    }
  }

  async function runAction<T>(
    key: string,
    url: string,
    init: RequestInit,
    onSuccess?: (result: T) => void,
  ) {
    if (!session?.csrfToken) {
      setError('No active session');
      return;
    }
    setBusyAction(key);
    setError(null);
    setActionMessage(null);
    try {
      const result = await api<T>(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': session.csrfToken,
          ...(init.headers ?? {}),
        },
      });
      onSuccess?.(result);
      await refreshData();
      setActionMessage(`${key} completed`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${key} failed`);
    } finally {
      setBusyAction(null);
    }
  }

  function updateForm<K extends keyof typeof forms>(key: K, value: (typeof forms)[K]) {
    setForms((current) => ({ ...current, [key]: value }));
  }

  async function sendChat(event: React.FormEvent) {
    event.preventDefault();
    if (!session?.csrfToken || !chatSocketRef.current || chatSocketRef.current.readyState !== WebSocket.OPEN) {
      setError('Chat bridge is not connected');
      return;
    }
    const trimmedAuthor = chatAuthor.trim();
    const trimmedMessage = chatMessage.trim();
    if (!trimmedAuthor || !trimmedMessage) {
      return;
    }
    chatSocketRef.current.send(
      JSON.stringify({
        type: 'chat_send',
        csrfToken: session.csrfToken,
        payload: {
          author: trimmedAuthor,
          message: trimmedMessage,
        },
      }),
    );
    setChatLines((current) => [...current.slice(-49), { type: 'system', text: `Sent as ${trimmedAuthor}` }]);
    setChatMessage('');
  }

  if (loading && !session?.authenticated) {
    return (
      <div className="page-shell">
        <div className="loading-panel">
          <p>Loading secure control panel…</p>
        </div>
      </div>
    );
  }

  if (!session?.authenticated) {
    return (
      <div className="page-shell">
        <div className="login-card">
          <div className="login-banner">
            <span className="eyebrow">Security-first control plane</span>
            <h1>{appConfig.appName ?? 'JunimoServer Control'}</h1>
            <p>
              This UI never exposes the upstream Junimo `API_KEY` to the browser. All calls go through a
              same-origin proxy with session auth, CSRF, and write-path guardrails.
            </p>
          </div>
          <form className="login-form" onSubmit={login}>
            <label>
              <span>Admin password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="Enter ADMIN_PASSWORD"
              />
            </label>
            <button type="submit">Unlock panel</button>
            {error ? <p className="error-text">{error}</p> : null}
          </form>
          <div className="login-footnote">
            <span>Proxy target: {appConfig.baseUrlHint ?? 'configured on server'}</span>
            <a href={appConfig.documentationUrl ?? '#'} target="_blank" rel="noreferrer">
              API reference
            </a>
          </div>
        </div>
      </div>
    );
  }

  const headerMetrics = dashboard ? [
    { label: 'Server', value: dashboard.status.isOnline ? 'Online' : 'Offline', tone: metricTone(Boolean(dashboard.status.isOnline)) },
    { label: 'Players', value: `${dashboard.players.players.length} / ${dashboard.status.maxPlayers}` },
    { label: 'Time', value: fmtTimeOfDay(dashboard.status.timeOfDay) },
    { label: 'Date', value: `${dashboard.status.season} ${dashboard.status.day}, Y${dashboard.status.year}` }
  ] : [];

  return (
    <AppLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={[
        { id: 'dashboard', label: 'Dashboard', icon: '📊' },
        { id: 'screenshot', label: 'Screenshot', icon: '📷' },
        { id: 'map', label: 'Map View', icon: '🗺️' },
        { id: 'console', label: 'Console', icon: '💻' }
      ]}
      headerMetrics={headerMetrics}
      performanceHistory={performanceHistory}
      rightAction={
        <div style={{display: 'flex', gap: '8px'}}>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setLoading(true);
              refreshData().catch((reason) => {
                addToast(reason instanceof Error ? reason.message : 'Refresh failed', 'error');
                setLoading(false);
              });
            }}
          >
            Refresh
          </button>
          <button className="secondary-button" type="button" onClick={logout}>
            Sign out
          </button>
        </div>
      }
    >
      
      

      {activeTab === 'dashboard' && dashboard && (
        <div className="layout-grid">
          <div className="column">
            <Panel title="Overview" subtitle="Snapshot-backed state and settings">
              <div className="overview-grid">
                <div className="farm-tags">
                  <span className="farm-tag"><span className="tag-icon">🌾</span> {dashboard.status.farmName || 'Unnamed Farm'}</span>
                  <span className="farm-tag"><span className="tag-icon">🗺️</span> Type {dashboard.status.farmTypeKey || '-'}</span>
                  <span className="farm-tag"><span className="tag-icon">⏱️</span> {dashboard.status.lastUpdated ? relativeTime(dashboard.status.lastUpdated) : 'Not loaded'}</span>
                  <span className="farm-tag"><span className="tag-icon">🔒</span> {dashboard.auth.enabled ? 'Auth Enabled' : 'No Auth'}</span>
                  <span className="farm-tag"><span className="tag-icon">🏠</span> Cabins: {dashboard.cabins.strategy || '-'}</span>
                  {dashboard.settings.server.separateWallets && <span className="farm-tag"><span className="tag-icon">💰</span> Separate Wallets</span>}
                </div>
                
                <div className="invite-card">
                  <div>
                    <span className="label">Invite Code</span>
                    <span className="code">{dashboard.inviteCode.inviteCode ?? dashboard.inviteCode.error ?? 'Unavailable'}</span>
                  </div>
                  {dashboard.inviteCode.inviteCode && (
                    <CopyButton text={dashboard.inviteCode.inviteCode} />
                  )}
                </div>
              </div>
            </Panel>
            
            <Panel title="Cabins" subtitle="Assignment and hidden-stack state">
              <div className="stats-row">
                <Badge label="Total" value={dashboard.cabins.totalCount} />
                <Badge label="Assigned" value={dashboard.cabins.assignedCount} />
                <Badge label="Available" value={dashboard.cabins.availableCount} />
              </div>
              <Table
                headers={['Owner', 'Type', 'Tile', 'Assigned']}
                rows={dashboard.cabins.cabins.map((cabin) => [
                  cabin.ownerName || 'Unassigned',
                  cabin.type,
                  `${cabin.tileX}, ${cabin.tileY}`,
                  cabin.isAssigned ? 'Yes' : 'No',
                ])}
                emptyText="No cabins"
              />
            </Panel>
          </div>

          <div className="column" style={{ gridColumn: 'span 2' }}>
            <Panel title="Players" subtitle="Connected players and known farmhands">
              <Table
                headers={['Name', 'ID', 'Online', 'Actions']}
                rows={dashboard.players.players.map((player) => [
                  player.name,
                  String(player.id),
                  player.isOnline ? 'Yes' : 'No',
                  <div className="inline-actions" key={player.id}>
                    <button 
                      className="secondary-button" 
                      onClick={() => runAction('Grant admin', '/api/actions/grant-admin', {
                        method: 'POST',
                        body: JSON.stringify({ playerId: player.id })
                      })}
                    >
                      Admin
                    </button>
                  </div>
                ])}
                emptyText="No connected players"
              />
              <div className="table-spacer" />
              <Table
                headers={['Farmhand', 'ID', 'Customized', 'Actions']}
                rows={dashboard.farmhands.farmhands.map((farmhand) => [
                  farmhand.name,
                  String(farmhand.id),
                  farmhand.isCustomized ? 'Yes' : 'No',
                  <div className="inline-actions" key={farmhand.id}>
                    <button 
                      className="secondary-button"
                      style={{ color: 'var(--danger)' }}
                      onClick={() => runAction('Delete farmhand', '/api/actions/farmhand', {
                        method: 'DELETE',
                        body: JSON.stringify({ playerId: farmhand.id, confirmText: 'DELETE FARMHAND' })
                      })}
                    >
                      Delete
                    </button>
                  </div>
                ])}
                emptyText="No farmhand slots found"
              />
            </Panel>
          </div>
        </div>
      )}

      {activeTab === 'screenshot' && (
        <div className="layout-single">
          <Panel title="Live screenshot" subtitle="Fetched through the local secure proxy">
            {screenshotSrc ? (
              <img className="screenshot-frame full-map" src={screenshotSrc} alt="JunimoServer screenshot" />
            ) : (
              <div className="empty-state">Screenshot unavailable: {dashboard?.screenshot.error ?? 'No image data'}</div>
            )}
          </Panel>
        </div>
      )}

      {activeTab === 'map' && (
        <div className="layout-single" style={{ height: 'calc(100vh - 120px)' }}>
          <MapView />
        </div>
      )}

      {activeTab === 'console' && (
        <div className="layout-constrained">
            <Panel title="Server Configuration" subtitle="Low-risk runtime operations">
              <div className="settings-list">
                <div className="settings-row">
                  <div className="settings-info">
                    <h4>Auth timeout</h4>
                    <p>Update password-protection timeout in seconds.</p>
                  </div>
                  <div className="settings-action">
                    <input
                      value={forms.authTimeout}
                      onChange={(event) => updateForm('authTimeout', event.target.value)}
                    />
                    <button 
                      disabled={busyAction === 'Auth timeout'}
                      onClick={() => runAction('Auth timeout', '/api/actions/auth-timeout', { method: 'POST', body: JSON.stringify({ value: Number(forms.authTimeout) }) })}
                    >
                      Apply
                    </button>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-info">
                    <h4>Render rate</h4>
                    <p>Set `/rendering?fps=`. `0` disables rendering.</p>
                  </div>
                  <div className="settings-action">
                    <input
                      value={forms.renderingFps}
                      onChange={(event) => updateForm('renderingFps', event.target.value)}
                    />
                    <button 
                      disabled={busyAction === 'Render rate'}
                      onClick={() => runAction('Render rate', '/api/actions/rendering', { method: 'POST', body: JSON.stringify({ fps: Number(forms.renderingFps) }) })}
                    >
                      Apply
                    </button>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-info">
                    <h4>Set game time</h4>
                    <p>Valid upstream range is `600` to `2600`.</p>
                  </div>
                  <div className="settings-action">
                    <input
                      value={forms.timeOfDay}
                      onChange={(event) => updateForm('timeOfDay', event.target.value)}
                    />
                    <button 
                      disabled={busyAction === 'Set game time'}
                      onClick={() => runAction('Set game time', '/api/actions/time', { method: 'POST', body: JSON.stringify({ value: Number(forms.timeOfDay) }) })}
                    >
                      Apply
                    </button>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-info">
                    <h4>Clock speed</h4>
                    <p>Set `/clock-speed?multiplier=` to accelerate or slow the day.</p>
                  </div>
                  <div className="settings-action">
                    <input
                      value={forms.clockSpeed}
                      onChange={(event) => updateForm('clockSpeed', event.target.value)}
                    />
                    <button 
                      disabled={busyAction === 'Clock speed'}
                      onClick={() => runAction('Clock speed', '/api/actions/clock-speed', { method: 'POST', body: JSON.stringify({ multiplier: Number(forms.clockSpeed) }) })}
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </div>
            </Panel>

            <Panel title="Map Data" subtitle="Manage cached map parses">
              <div className="settings-list">
                <div className="settings-row">
                  <div className="settings-info">
                    <h4>Map API Base URL</h4>
                    <p>Where map requests will be proxied to (e.g. Map parser service)</p>
                  </div>
                  <div className="settings-action">
                    <input
                      value={forms.mapApiUrl}
                      onChange={(event) => {
                        updateForm('mapApiUrl', event.target.value);
                        localStorage.setItem('junimo_map_api_url', event.target.value);
                      }}
                      placeholder="http://localhost:8080"
                      style={{ width: '250px' }}
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-info">
                    <h4>Force refresh map caches</h4>
                    <p>Triggers upstream `/refresh` to re-parse all save slots.</p>
                  </div>
                  <div className="settings-action">
                    <button
                      className="secondary-button"
                      disabled={busyAction === 'Refresh maps'}
                      onClick={() => runAction('Refresh maps', '/api/map/refresh', {
                        method: 'POST',
                        headers: { 'x-map-api-url': forms.mapApiUrl }
                      })}
                    >
                      {busyAction === 'Refresh maps' ? 'Working...' : 'Refresh All'}
                    </button>
                  </div>
                </div>
              </div>
            </Panel>

            <Panel title="Danger Zone" subtitle="Destructive or disruptive operations">
              <div className="settings-list">
                <div className="settings-row">
                  <div className="settings-info">
                    <h4 style={{color: 'var(--danger)'}}>Reload World</h4>
                    <p>Calls upstream `/reload`. Fails closed when clients are connected.</p>
                  </div>
                  <div className="settings-action">
                    <button 
                      style={{background: 'var(--danger)'}}
                      onClick={() => setActiveModal('reload')}
                    >
                      Reload World
                    </button>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-info">
                    <h4 style={{color: 'var(--danger)'}}>Create New Game</h4>
                    <p>Wraps upstream `/newgame`. Replaces the active world.</p>
                  </div>
                  <div className="settings-action">
                    <button 
                      style={{background: 'var(--danger)'}}
                      onClick={() => setActiveModal('newgame')}
                    >
                      Create New Game
                    </button>
                  </div>
                </div>
              </div>
            </Panel>
        </div>
      )}


      <Modal isOpen={activeModal === 'reload'} onClose={() => setActiveModal(null)} title="Confirm Reload">
        <p style={{marginBottom: 16}}>Type <strong>RELOAD WORLD</strong> to confirm you want to reload the world. This will disconnect all players.</p>
        <form className="chat-form" onSubmit={(e) => {
          e.preventDefault();
          if (forms.reloadConfirm !== 'RELOAD WORLD') {
            setError(`Type exactly "RELOAD WORLD" before reloading.`);
            return;
          }
          setActiveModal(null);
          runAction('Reload world', '/api/actions/reload', {
            method: 'POST',
            body: JSON.stringify({ confirmText: forms.reloadConfirm }),
          });
        }}>
          <input 
            autoFocus
            value={forms.reloadConfirm} 
            onChange={(e) => updateForm('reloadConfirm', e.target.value)} 
            placeholder="RELOAD WORLD"
          />
          <button type="submit" style={{background: 'var(--danger)'}} disabled={busyAction === 'Reload world'}>Reload</button>
        </form>
      </Modal>

      <Modal isOpen={activeModal === 'newgame'} onClose={() => setActiveModal(null)} title="Create New Game">
        <p style={{marginBottom: 16}}>Configure your new world. This will replace the current save!</p>
        <form className="action-form-body" onSubmit={(e) => {
          e.preventDefault();
          const rawFarmType = forms.newGameFarmType.trim();
          const farmType = /^\d+$/.test(rawFarmType) ? Number(rawFarmType) : rawFarmType;
          setActiveModal(null);
          runAction('Create new game', '/api/actions/new-game', {
            method: 'POST',
            body: JSON.stringify({
              farmType,
              farmName: forms.newGameFarmName.trim() || undefined,
              startingCabins: Number(forms.newGameStartingCabins),
              cabinStrategy: forms.newGameCabinStrategy,
              maxPlayers: Number(forms.newGameMaxPlayers),
              profitMargin: Number(forms.newGameProfitMargin),
              separateWallets: forms.newGameSeparateWallets,
              confirmText: forms.newGameConfirm,
            }),
          });
        }}>
          <label><span>Farm type (0-6 or custom ID)</span><input value={forms.newGameFarmType} onChange={(e) => updateForm('newGameFarmType', e.target.value)} /></label>
          <label><span>Farm name</span><input value={forms.newGameFarmName} onChange={(e) => updateForm('newGameFarmName', e.target.value)} /></label>
          <label><span>Starting cabins</span><input value={forms.newGameStartingCabins} onChange={(e) => updateForm('newGameStartingCabins', e.target.value)} /></label>
          <label><span>Cabin strategy</span>
            <select value={forms.newGameCabinStrategy} onChange={(e) => updateForm('newGameCabinStrategy', e.target.value)}>
              <option value="CabinStack">CabinStack</option>
              <option value="FarmhouseStack">FarmhouseStack</option>
              <option value="None">None</option>
            </select>
          </label>
          <label><span>Max players</span><input value={forms.newGameMaxPlayers} onChange={(e) => updateForm('newGameMaxPlayers', e.target.value)} /></label>
          <label><span>Profit margin</span><input value={forms.newGameProfitMargin} onChange={(e) => updateForm('newGameProfitMargin', e.target.value)} /></label>
          <label className="checkbox-row"><input type="checkbox" checked={forms.newGameSeparateWallets} onChange={(e) => updateForm('newGameSeparateWallets', e.target.checked)} /><span>Separate wallets</span></label>
          <label><span>Type <strong>CREATE NEW GAME</strong></span><input value={forms.newGameConfirm} onChange={(e) => updateForm('newGameConfirm', e.target.value)} placeholder="CREATE NEW GAME" /></label>
          
          <div style={{marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 12}}>
            <button type="button" className="secondary-button" onClick={() => setActiveModal(null)}>Cancel</button>
            <button type="submit" style={{background: 'var(--danger)'}} disabled={busyAction === 'Create new game'}>Create Game</button>
          </div>
        </form>
      </Modal>

      <ChatWidget
        connected={chatConnected}
        authenticated={session?.authenticated ?? false}
        lines={chatLines}
        author={chatAuthor}
        setAuthor={setChatAuthor}
        message={chatMessage}
        setMessage={setChatMessage}
        onSend={sendChat}
      />
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </AppLayout>
  );
}

function Panel(props: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>{props.title}</h2>
          {props.subtitle ? <p>{props.subtitle}</p> : null}
        </div>
      </div>
      {props.children}
    </section>
  );
}

function DataList(props: { items: Array<[string, string | React.ReactNode]> }) {
  return (
    <dl className="data-list">
      {props.items.map(([label, value]) => (
        <div key={label} className="data-list-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Table(props: { headers: string[]; rows: React.ReactNode[][]; emptyText: string }) {
  if (props.rows.length === 0) {
    return <div className="empty-state">{props.emptyText}</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {props.headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => (
            <tr key={`row-${index}`}>
              {row.map((value, cellIndex) => (
                <td key={`${index}-${cellIndex}`}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Badge(props: { label: string; value: number }) {
  return (
    <div className="badge-card">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function ActionForm(props: {
  title: string;
  description: string;
  busy: boolean;
  danger?: boolean;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <form className={`action-form${props.danger ? ' action-form-danger' : ''}`} onSubmit={props.onSubmit}>
      <div className="action-form-header">
        <h3>{props.title}</h3>
        <p>{props.description}</p>
      </div>
      <div className="action-form-body">{props.children}</div>
      <button type="submit" disabled={props.busy}>
        {props.busy ? 'Working…' : props.title}
      </button>
    </form>
  );
}
