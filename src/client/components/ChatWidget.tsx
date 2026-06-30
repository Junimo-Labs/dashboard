import React, { useState, useEffect } from 'react';

export function ChatWidget(props: {
  connected: boolean;
  authenticated: boolean;
  lines: Array<{ type: string; text: string }>;
  author: string;
  setAuthor: (author: string) => void;
  message: string;
  setMessage: (message: string) => void;
  onSend: (e: React.FormEvent) => void;
  error?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [lastReadIndex, setLastReadIndex] = useState(props.lines.length);

  useEffect(() => {
    if (expanded) {
      setLastReadIndex(props.lines.length);
    }
  }, [expanded, props.lines.length]);

  const unreadCount = props.lines.length - lastReadIndex;

  if (!expanded) {
    return (
      <button className="chat-widget-fab" onClick={() => setExpanded(true)}>
        <span className="chat-widget-icon">💬</span>
        {unreadCount > 0 && <span className="chat-widget-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
    );
  }

  return (
    <div className="chat-widget-panel panel">
      <div className="chat-widget-header panel-header">
        <h2>Chat Bridge</h2>
        <button className="chat-widget-close secondary-button" onClick={() => setExpanded(false)}>
          ▼
        </button>
      </div>
      <div className="chat-widget-body">
        <div className="chat-status-row">
          <span className={`status-pill ${props.connected ? 'status-ok' : 'status-offline'}`}>
            {props.connected ? 'WSS connected' : 'WSS offline'}
          </span>
          <span className="muted-text">
            {props.authenticated ? 'Auth ready' : 'Auth pending'}
          </span>
        </div>
        {props.error && <div className="notice notice-error" style={{marginTop: 8}}>{props.error}</div>}
        <div className="chat-log chat-widget-log">
          {props.lines.length === 0 ? <div className="empty-state">No chat traffic yet.</div> : null}
          {props.lines.map((line, index) => (
            <div key={`${line.type}-${index}`} className={`chat-line chat-${line.type}`}>
              {line.text}
            </div>
          ))}
        </div>
        <form className="chat-form" onSubmit={props.onSend}>
          <label>
            <span>Author</span>
            <input value={props.author} onChange={(event) => props.setAuthor(event.target.value)} />
          </label>
          <label className="chat-message-input">
            <span>Message</span>
            <input value={props.message} onChange={(event) => props.setMessage(event.target.value)} />
          </label>
          <button type="submit" disabled={!props.connected || !props.authenticated}>Send</button>
        </form>
      </div>
    </div>
  );
}
