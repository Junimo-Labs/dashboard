import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  assessConnection,
  buildWebSocketUrl,
  clearStoredConnection,
  createEmptyDashboard,
  createNewGame,
  deleteFarmhand,
  fetchDashboard,
  grantAdminRole,
  loadStoredConnection,
  normalizeApiBaseUrl,
  reloadWorld,
  runtimeConfig,
  saveConnection,
  setAuthTimeout,
  setClockSpeed,
  setRendering,
  setTimeOfDay,
  type ConnectionConfig,
  type DashboardData,
} from './directApi';

import { AppLayout } from './components/Layout';
import { ChatWidget } from './components/ChatWidget';
import { Modal } from './components/Modal';
import { CopyButton } from './components/CopyButton';
import { ToastContainer, type ToastMessage } from './components/Toast';


import { MapView } from './components/MapView';

const DELETE_CONFIRM_TEXT = 'DELETE FARMHAND';
const RELOAD_CONFIRM_TEXT = 'RELOAD WORLD';
const NEW_GAME_CONFIRM_TEXT = 'CREATE NEW GAME';
const CABIN_STRATEGIES = ['CabinStack', 'FarmhouseStack', 'None'] as const;

function fmtTimeOfDay(value: number): string {
  if (!value) {
    return 'Unknown';
  }
  const padded = value.toString().padStart(4, '0');
  const hours = Number.parseInt(padded.slice(0, 2), 10) % 24;
  const minutes = Number.parseInt(padded.slice(2), 10);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) {
    return '-';
  }
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
  if (!base64Png) return null;
  return `data:image/png;base64,${base64Png}`;
}

function extractMessage(result: unknown, fallback: string): string {
  if (
    typeof result === 'object' &&
    result !== null &&
    'message' in result &&
    typeof (result as { message?: unknown }).message === 'string' &&
    (result as { message: string }).message.length > 0
  ) {
    return (result as { message: string }).message;
  }
  return fallback;
}

export function DirectApp() {
  const [draftConnection, setDraftConnection] = useState<ConnectionConfig>(() => loadStoredConnection());
  const [activeConnection, setActiveConnection] = useState<ConnectionConfig>(() => loadStoredConnection());
  const [dashboard, setDashboard] = useState<DashboardData>(() => createEmptyDashboard());
  
  const [loading, setLoading] = useState<boolean>(() =>
    Boolean(normalizeApiBaseUrl(loadStoredConnection().apiBaseUrl)),
  );
  const [activeTab, setActiveTab] = useState<string>(() => 
    normalizeApiBaseUrl(loadStoredConnection().apiBaseUrl) ? 'dashboard' : 'settings'
  );

  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
    const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, type, message }]);
  };

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [chatConnected, setChatConnected] = useState(false);
  const [chatAuthenticated, setChatAuthenticated] = useState(false);
  const [chatLines, setChatLines] = useState<Array<{ type: string; text: string }>>([]);
  const [chatAuthor, setChatAuthor] = useState('AdminConsole');
  const [chatMessage, setChatMessage] = useState('');
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
    newGameCabinStrategy: 'CabinStack' as (typeof CABIN_STRATEGIES)[number],
    newGameMaxPlayers: '8',
    newGameProfitMargin: '1',
    newGameSeparateWallets: false,
    mapApiUrl: localStorage.getItem('junimo_map_api_url') || 'http://localhost:8080'
  });
  const chatSocketRef = useRef<WebSocket | null>(null);

  const draftAssessment = useMemo(() => assessConnection(draftConnection), [draftConnection]);
  const activeAssessment = useMemo(() => assessConnection(activeConnection), [activeConnection]);
  const screenshotSrc = useMemo(
    () => screenshotUrl(dashboard.screenshot.base64Png),
    [dashboard.screenshot.base64Png],
  );
  const endpointErrors = useMemo(
    () => Object.entries(dashboard.endpointErrors),
    [dashboard.endpointErrors],
  );

  async function refreshData(
    connection: ConnectionConfig = activeConnection,
    nextIncludeDiagnostics = includeDiagnostics,
  ) {
    const normalizedBaseUrl = normalizeApiBaseUrl(connection.apiBaseUrl);
    if (!normalizedBaseUrl) {
      setDashboard(createEmptyDashboard());
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const nextDashboard = await fetchDashboard(connection, nextIncludeDiagnostics);
      setDashboard(nextDashboard);
      
      setPerformanceHistory(prev => {
        const keep = 30;
        return {
          tps: [...prev.tps, nextDashboard.stats.tps].slice(-keep),
          memory: [...prev.memory, nextDashboard.stats.memoryMb].slice(-keep),
          avgTick: [...prev.avgTick, nextDashboard.stats.avgTickMs].slice(-keep),
        };
      });

      setError(null);
    } catch (reason) {
      setDashboard(createEmptyDashboard());
      addToast(reason instanceof Error ? reason.message : 'Failed to reach JunimoServer', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const initialConnection = loadStoredConnection();
    if (normalizeApiBaseUrl(initialConnection.apiBaseUrl)) {
      void refreshData(initialConnection, includeDiagnostics);
    } else {
      setLoading(false);
    }

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        const currentConnection = loadStoredConnection();
        if (normalizeApiBaseUrl(currentConnection.apiBaseUrl)) {
          refreshData(currentConnection, includeDiagnostics).catch(console.error);
        }
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [includeDiagnostics]);

  useEffect(() => {
    const normalizedBaseUrl = activeAssessment.normalizedBaseUrl;
    if (!normalizedBaseUrl || activeAssessment.mixedContentRisk) {
      if (chatSocketRef.current) {
        chatSocketRef.current.close();
        chatSocketRef.current = null;
      }
      setChatConnected(false);
      setChatAuthenticated(false);
      return;
    }

    const socket = new WebSocket(buildWebSocketUrl(normalizedBaseUrl));
    chatSocketRef.current = socket;
    setChatAuthenticated(false);

    socket.addEventListener('open', () => {
      setChatConnected(true);
      setChatLines((current) => [
        ...current.slice(-49),
        { type: 'system', text: `WebSocket connected to ${normalizedBaseUrl}` },
      ]);
      const apiKey = activeConnection.apiKey.trim();
      if (!apiKey) {
        setChatAuthenticated(true);
        return;
      }
      socket.send(
        JSON.stringify({
          type: 'auth',
          payload: { token: apiKey },
        }),
      );
    });

    socket.addEventListener('close', () => {
      setChatConnected(false);
      setChatAuthenticated(false);
      setChatLines((current) => [
        ...current.slice(-49),
        { type: 'system', text: 'WebSocket disconnected' },
      ]);
    });

    socket.addEventListener('error', () => {
      setChatLines((current) => [
        ...current.slice(-49),
        { type: 'error', text: 'WebSocket connection failed' },
      ]);
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          type?: string;
          payload?: { playerName?: string; message?: string; error?: string };
        };
        if (payload.type === 'auth_success') {
          setChatAuthenticated(true);
          setChatLines((current) => [
            ...current.slice(-49),
            { type: 'system', text: 'WebSocket authenticated' },
          ]);
          return;
        }
        if (payload.type === 'auth_failed') {
          setChatAuthenticated(false);
          setChatLines((current) => [
            ...current.slice(-49),
            { type: 'error', text: payload.payload?.error ?? 'WebSocket auth failed' },
          ]);
          return;
        }
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
        if (payload.type === 'pong') {
          return;
        }
        if (payload.type === 'error') {
          setChatLines((current) => [
            ...current.slice(-49),
            { type: 'error', text: payload.payload?.error ?? 'Unknown WebSocket error' },
          ]);
          return;
        }
      } catch {
        setChatLines((current) => [
          ...current.slice(-49),
          { type: 'system', text: String(event.data) },
        ]);
      }
    });

    return () => {
      socket.close();
    };
  }, [
    activeAssessment.mixedContentRisk,
    activeAssessment.normalizedBaseUrl,
    activeConnection.apiKey,
  ]);

  function updateDraft<K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) {
    setDraftConnection((current) => ({ ...current, [key]: value }));
  }

  function updateForm<K extends keyof typeof forms>(key: K, value: (typeof forms)[K]) {
    setForms((current) => ({ ...current, [key]: value }));
  }

  async function applyConnection(event: React.FormEvent) {
    event.preventDefault();
    const nextConnection: ConnectionConfig = {
      apiBaseUrl: normalizeApiBaseUrl(draftConnection.apiBaseUrl),
      apiKey: draftConnection.apiKey.trim(),
      rememberApiKey: draftConnection.rememberApiKey,
    };

    saveConnection(nextConnection);
    setDraftConnection(nextConnection);
    setActiveConnection(nextConnection);
    setError(null);
    setActionMessage(
      nextConnection.apiBaseUrl
        ? `Browser-direct target saved: ${nextConnection.apiBaseUrl}`
        : 'Connection cleared',
    );

    if (!nextConnection.apiBaseUrl) {
      setDashboard(createEmptyDashboard());
      setLoading(false);
      return;
    }

    setActiveTab('dashboard');
    await refreshData(nextConnection, includeDiagnostics);
  }

  async function resetConnection() {
    clearStoredConnection();
    const nextConnection = loadStoredConnection();
    setDraftConnection(nextConnection);
    setActiveConnection(nextConnection);
    setDashboard(createEmptyDashboard());
    setChatLines([]);
    setError(null);
    setActionMessage('Stored browser connection cleared');
    if (normalizeApiBaseUrl(nextConnection.apiBaseUrl)) {
      await refreshData(nextConnection, includeDiagnostics);
    } else {
      setLoading(false);
    }
  }

  async function runAction<T>(label: string, operation: () => Promise<T>) {
    if (!activeAssessment.normalizedBaseUrl) {
      setError('Configure an API address first.');
      return;
    }
    setBusyAction(label);
    setError(null);
    setActionMessage(null);
    try {
      const result = await operation();
      setActionMessage(extractMessage(result, `${label} completed`));
      await refreshData(activeConnection, includeDiagnostics);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${label} failed`);
    } finally {
      setBusyAction(null);
    }
  }

  async function toggleDiagnostics(next: boolean) {
    setIncludeDiagnostics(next);
    if (!activeAssessment.normalizedBaseUrl) {
      return;
    }
    await refreshData(activeConnection, next);
  }

  function sendChat(event: React.FormEvent) {
    event.preventDefault();
    const socket = chatSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError('WebSocket is not connected');
      return;
    }

    const trimmedAuthor = chatAuthor.trim();
    const trimmedMessage = chatMessage.trim();
    if (!trimmedAuthor || !trimmedMessage) {
      return;
    }

    if (activeConnection.apiKey.trim() && !chatAuthenticated) {
      setError('WebSocket auth is not ready yet');
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'chat_send',
        payload: {
          author: trimmedAuthor,
          message: trimmedMessage,
        },
      }),
    );
    setChatLines((current) => [
      ...current.slice(-49),
      { type: 'system', text: `Sent as ${trimmedAuthor}` },
    ]);
    setChatMessage('');
  }

  const headerMetrics = [
    { label: 'Server', value: dashboard.status.isOnline ? 'Online' : 'Offline', tone: metricTone(Boolean(dashboard.status.isOnline)) },
    { label: 'Players', value: `${dashboard.players.players.length} / ${dashboard.status.maxPlayers}` },
    { label: 'Time', value: fmtTimeOfDay(dashboard.status.timeOfDay) },
    { label: 'Date', value: `${dashboard.status.season} ${dashboard.status.day}, Y${dashboard.status.year}` }
  ];

  return (
    <AppLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={[
        { id: 'dashboard', label: 'Dashboard', icon: '📊' },
        { id: 'screenshot', label: 'Screenshot', icon: '📷' },
        { id: 'map', label: 'Map View', icon: '🗺️' },
        { id: 'console', label: 'Console', icon: '💻' },
        { id: 'settings', label: 'Settings', icon: '⚙️' }
      ]}
      headerMetrics={headerMetrics}
      performanceHistory={performanceHistory}
      rightAction={
        <button
          className="secondary-button"
          type="button"
          disabled={!activeAssessment.normalizedBaseUrl || loading}
          onClick={() => {
            void refreshData(activeConnection, includeDiagnostics);
          }}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    >
      
      

      {activeTab === 'settings' && (
        <div className="layout-constrained">
            <Panel
              title="Connection"
              subtitle="Runtime browser config. API key is session-only by default unless you explicitly choose to remember it."
            >
              <form className="connection-grid" onSubmit={applyConnection}>
                <label className="connection-field connection-field-wide">
                  <span>API base URL</span>
                  <input
                    value={draftConnection.apiBaseUrl}
                    onChange={(event) => updateDraft('apiBaseUrl', event.target.value)}
                    placeholder={
                      runtimeConfig.defaultApiBaseUrl
                        ? `Default: ${runtimeConfig.defaultApiBaseUrl}`
                        : 'http://127.0.0.1:8080'
                    }
                  />
                </label>
                <label className="connection-field connection-field-wide">
                  <span>API key</span>
                  <input
                    type="password"
                    value={draftConnection.apiKey}
                    onChange={(event) => updateDraft('apiKey', event.target.value)}
                    placeholder="Optional only if upstream API_KEY is unset"
                  />
                </label>
                <label className="checkbox-row connection-checkbox">
                  <input
                    type="checkbox"
                    checked={draftConnection.rememberApiKey}
                    onChange={(event) => updateDraft('rememberApiKey', event.target.checked)}
                  />
                  <span>Remember API key in local storage</span>
                </label>
                <div className="connection-actions">
                  <button type="submit">Save and connect</button>
                  <button className="secondary-button" type="button" onClick={() => void resetConnection()}>
                    Clear stored config
                  </button>
                </div>
              </form>

              <div className="connection-summary">
                <InfoChip
                  label="Current target"
                  value={activeAssessment.normalizedBaseUrl || 'Not configured'}
                />
                <InfoChip
                  label="Mode"
                  value={
                    activeAssessment.normalizedBaseUrl
                      ? activeAssessment.sameOrigin
                        ? 'Same-origin direct'
                        : 'Cross-origin direct'
                      : 'No connection'
                  }
                />
                <InfoChip
                  label="API key storage"
                  value={
                    activeConnection.apiKey
                      ? activeConnection.rememberApiKey
                        ? 'localStorage'
                        : 'sessionStorage'
                      : 'No key'
                  }
                />
              </div>

              <div className="assessment-grid">
                <MessageCard
                  tone="warn"
                  title="Warnings"
                  items={
                    draftAssessment.warnings.length > 0
                      ? draftAssessment.warnings
                      : ['No immediate browser-side warning detected for the current draft connection.']
                  }
                />
                <MessageCard
                  tone="note"
                  title="Notes"
                  items={[
                    ...draftAssessment.notes,
                    'Direct mode keeps deployment simple because the container only serves static assets.',
                    'WebSocket chat can still work cross-origin because auth happens in-band after connect.',
                  ]}
                />
              </div>
            </Panel>

            <Panel
              title="Map Data"
              subtitle="Configure where map requests will be sent in direct mode"
            >
              <div className="connection-grid">
                <label className="connection-field connection-field-wide">
                  <span>Map API base URL</span>
                  <input
                    value={forms.mapApiUrl}
                    onChange={(event) => {
                      updateForm('mapApiUrl', event.target.value);
                      localStorage.setItem('junimo_map_api_url', event.target.value);
                    }}
                    placeholder={
                      runtimeConfig.defaultApiBaseUrl
                        ? `Default: ${runtimeConfig.defaultApiBaseUrl}`
                        : 'http://localhost:8080'
                    }
                  />
                </label>
              </div>
              <div className="connection-summary">
                <InfoChip
                  label="Refresh maps"
                  value="Not supported in direct mode"
                />
              </div>
            </Panel>
        </div>
      )}

      {activeTab === 'dashboard' && (
        <div className="layout-grid">
          <div className="column">
            <Panel title="Overview" subtitle="Snapshot-backed state and settings">
              <div className="overview-grid">
                <div className="farm-tags">
                  <span className="farm-tag"><span className="tag-icon">🌾</span> {dashboard.status.farmName || 'Unnamed Farm'}</span>
                  <span className="farm-tag"><span className="tag-icon">🗺️</span> Type {dashboard.status.farmTypeKey || '-'}</span>
                  <span className="farm-tag"><span className="tag-icon">⏱️</span> {dashboard.lastLoadedAt ? relativeTime(dashboard.lastLoadedAt) : 'Not loaded'}</span>
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
                      onClick={() => runAction('Grant admin', () => grantAdminRole(activeConnection, { playerId: player.id }))}
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
                      onClick={() => runAction('Delete farmhand', () => deleteFarmhand(activeConnection, { playerId: farmhand.id, confirmText: DELETE_CONFIRM_TEXT }))}
                    >
                      Delete
                    </button>
                  </div>
                ])}
                emptyText="No farmhand slots found"
              />
            </Panel>

            {endpointErrors.length > 0 ? (
              <Panel
                title="Partial request failures"
                subtitle="The dashboard renders with partial data. These endpoints failed on the last refresh."
              >
                <Table
                  headers={['Endpoint', 'Error']}
                  rows={endpointErrors.map(([endpoint, message]) => [endpoint, message])}
                  emptyText="No endpoint failures"
                />
              </Panel>
            ) : null}
          </div>
        </div>
      )}

      {activeTab === 'screenshot' && (
        <div className="layout-single">
          <Panel
            title="Live screenshot"
            subtitle="Direct request to `/screenshot`. Cross-origin mode with API key may be blocked by browser CORS."
          >
            {screenshotSrc ? (
              <img className="screenshot-frame full-map" src={screenshotSrc} alt="JunimoServer screenshot" />
            ) : (
              <div className="empty-state">
                Screenshot unavailable: {dashboard.screenshot.error ?? 'No image data'}
              </div>
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
            <Panel title="Server Configuration" subtitle="Runtime operations sent directly from the browser">
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
                      onClick={() => runAction('Auth timeout', () => setAuthTimeout(activeConnection, { value: Number(forms.authTimeout) }))}
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
                      onClick={() => runAction('Render rate', () => setRendering(activeConnection, { fps: Number(forms.renderingFps) }))}
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
                      onClick={() => runAction('Set game time', () => setTimeOfDay(activeConnection, { value: Number(forms.timeOfDay) }))}
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
                      onClick={() => runAction('Clock speed', () => setClockSpeed(activeConnection, { multiplier: Number(forms.clockSpeed) }))}
                    >
                      Apply
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
        <p style={{marginBottom: 16}}>Type <strong>{RELOAD_CONFIRM_TEXT}</strong> to confirm you want to reload the world. This will disconnect all players.</p>
        <form className="chat-form" onSubmit={(e) => {
          e.preventDefault();
          if (forms.reloadConfirm !== RELOAD_CONFIRM_TEXT) {
            setError(`Type exactly "${RELOAD_CONFIRM_TEXT}" before reloading.`);
            return;
          }
          setActiveModal(null);
          void runAction('Reload world', () => reloadWorld(activeConnection));
        }}>
          <input 
            autoFocus
            value={forms.reloadConfirm} 
            onChange={(e) => updateForm('reloadConfirm', e.target.value)} 
            placeholder={RELOAD_CONFIRM_TEXT}
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
          void runAction('Create new game', () =>
            createNewGame(activeConnection, {
              farmType,
              farmName: forms.newGameFarmName.trim() || undefined,
              startingCabins: Number(forms.newGameStartingCabins),
              cabinStrategy: forms.newGameCabinStrategy,
              maxPlayers: Number(forms.newGameMaxPlayers),
              profitMargin: Number(forms.newGameProfitMargin),
              separateWallets: forms.newGameSeparateWallets,
              confirmText: NEW_GAME_CONFIRM_TEXT,
            }),
          );
        }}>
          <label><span>Farm type (0-6 or custom ID)</span><input value={forms.newGameFarmType} onChange={(e) => updateForm('newGameFarmType', e.target.value)} /></label>
          <label><span>Farm name</span><input value={forms.newGameFarmName} onChange={(e) => updateForm('newGameFarmName', e.target.value)} /></label>
          <label><span>Starting cabins</span><input value={forms.newGameStartingCabins} onChange={(e) => updateForm('newGameStartingCabins', e.target.value)} /></label>
          <label><span>Cabin strategy</span>
            <select value={forms.newGameCabinStrategy} onChange={(e) => updateForm('newGameCabinStrategy', e.target.value as any)}>
              {CABIN_STRATEGIES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label><span>Max players</span><input value={forms.newGameMaxPlayers} onChange={(e) => updateForm('newGameMaxPlayers', e.target.value)} /></label>
          <label><span>Profit margin</span><input value={forms.newGameProfitMargin} onChange={(e) => updateForm('newGameProfitMargin', e.target.value)} /></label>
          <label className="checkbox-row"><input type="checkbox" checked={forms.newGameSeparateWallets} onChange={(e) => updateForm('newGameSeparateWallets', e.target.checked)} /><span>Separate wallets</span></label>
          <label><span>Type <strong>{NEW_GAME_CONFIRM_TEXT}</strong></span><input value={forms.newGameConfirm} onChange={(e) => updateForm('newGameConfirm', e.target.value)} placeholder={NEW_GAME_CONFIRM_TEXT} /></label>
          
          <div style={{marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 12}}>
            <button type="button" className="secondary-button" onClick={() => setActiveModal(null)}>Cancel</button>
            <button type="submit" style={{background: 'var(--danger)'}} disabled={busyAction === 'Create new game'}>Create Game</button>
          </div>
        </form>
      </Modal>

      <ChatWidget
        connected={chatConnected}
        authenticated={chatAuthenticated}
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

function InfoChip(props: { label: string; value: string }) {
  return (
    <div className="info-chip">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function MessageCard(props: { tone: 'warn' | 'note'; title: string; items: string[] }) {
  return (
    <div className={`message-card message-card-${props.tone}`}>
      <h3>{props.title}</h3>
      <ul>
        {props.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
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
