import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import dotenv from 'dotenv';
import { z, ZodError } from 'zod';

dotenv.config();

import { loadConfig } from './server/config.js';
import { RateLimiter, SessionStore, type SessionRecord } from './server/auth.js';
import {
  authStatusResponseSchema,
  authTimeoutResponseSchema,
  cabinsResponseSchema,
  clockSpeedResponseSchema,
  deleteFarmhandInputSchema,
  diagnosticsStateResponseSchema,
  farmhandResponseSchema,
  farmhandsResponseSchema,
  healthResponseSchema,
  inviteCodeResponseSchema,
  newGameRequestSchema,
  newGameResponseSchema,
  playersResponseSchema,
  reloadWorldInputSchema,
  reloadResponseSchema,
  renderingSetResponseSchema,
  renderingStatusSchema,
  roleGrantInputSchema,
  roleGrantResponseSchema,
  screenshotResponseSchema,
  serverStatusSchema,
  setAuthTimeoutInputSchema,
  setClockSpeedInputSchema,
  setRenderingInputSchema,
  setTimeInputSchema,
  settingsResponseSchema,
  statsResponseSchema,
  timeSetResponseSchema,
} from './shared/junimo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistDir = path.resolve(__dirname, '../client');
const config = loadConfig();

const SESSION_COOKIE = 'junimo_session';
const CSRF_HEADER = 'x-csrf-token';
const authSessionStore = new SessionStore(config.SESSION_TTL_HOURS * 60 * 60 * 1000);
const loginRateLimiter = new RateLimiter(
  config.LOGIN_RATE_LIMIT_WINDOW_MS,
  config.LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
);
const actionRateLimiter = new RateLimiter(
  config.ACTION_RATE_LIMIT_WINDOW_MS,
  config.ACTION_RATE_LIMIT_MAX_ATTEMPTS,
);

const app = Fastify({
  logger: true,
  trustProxy: config.TRUST_PROXY,
});

type RequestContext = {
  session: SessionRecord | null;
};

type ReadEndpointDef<T> = {
  key: string;
  path: string;
  parser: z.ZodType<T>;
};

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const readEndpoints = {
  status: { key: 'status', path: '/status', parser: serverStatusSchema },
  players: { key: 'players', path: '/players', parser: playersResponseSchema },
  inviteCode: { key: 'inviteCode', path: '/invite-code', parser: inviteCodeResponseSchema },
  health: { key: 'health', path: '/health', parser: healthResponseSchema },
  stats: { key: 'stats', path: '/stats', parser: statsResponseSchema },
  farmhands: { key: 'farmhands', path: '/farmhands', parser: farmhandsResponseSchema },
  settings: { key: 'settings', path: '/settings', parser: settingsResponseSchema },
  cabins: { key: 'cabins', path: '/cabins', parser: cabinsResponseSchema },
  rendering: { key: 'rendering', path: '/rendering', parser: renderingStatusSchema },
  screenshot: { key: 'screenshot', path: '/screenshot', parser: screenshotResponseSchema },
  auth: { key: 'auth', path: '/auth', parser: authStatusResponseSchema },
  diagnostics: {
    key: 'diagnostics',
    path: '/diagnostics/state',
    parser: diagnosticsStateResponseSchema,
  },
} satisfies Record<string, ReadEndpointDef<unknown>>;

const allowedReadKeys = Object.keys(readEndpoints) as Array<keyof typeof readEndpoints>;

const dashboardQuerySchema = z
  .object({
    diagnostics: z
      .union([z.literal('true'), z.literal('false')])
      .optional()
      .transform((value) => value === 'true'),
  })
  .default({});

const loginBodySchema = z.object({
  password: z.string().min(1),
});

const upstreamErrorSchema = z.object({
  error: z.string().optional(),
  success: z.boolean().optional(),
  message: z.string().optional(),
});

await app.register(cookie, {
  secret: config.sessionSecret,
});

await app.register(formbody);
await app.register(cors, {
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed'), false);
  },
  credentials: true,
});
await app.register(websocket);

if (config.NODE_ENV === 'production') {
  await app.register(fastifyStatic, {
    root: clientDistDir,
    prefix: '/',
    wildcard: false,
  });
}

app.decorateRequest('context', { session: null });

declare module 'fastify' {
  interface FastifyRequest {
    context: RequestContext;
  }
}

function getRemoteAddress(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return request.ip;
}

function setSessionCookie(reply: FastifyReply, session: SessionRecord): void {
  reply.setCookie(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.NODE_ENV === 'production',
    path: '/',
    maxAge: config.SESSION_TTL_HOURS * 60 * 60,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.NODE_ENV === 'production',
    path: '/',
  });
}

async function fetchJunimoJson<T>(
  pathname: string,
  init: RequestInit,
  parser: z.ZodType<T>,
  baseUrlOverride?: string,
): Promise<T> {
  const url = new URL(pathname, baseUrlOverride || config.JUNIMO_BASE_URL);
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.JUNIMO_API_KEY}`,
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: `Upstream returned non-JSON response (${response.status})` };
    }
  }

  if (!response.ok) {
    const upstreamError = upstreamErrorSchema.safeParse(payload);
    const message = upstreamError.success
      ? upstreamError.data.error ?? upstreamError.data.message ?? `Upstream request failed (${response.status})`
      : `Upstream request failed (${response.status})`;
    throw new HttpError(502, message);
  }

  return parser.parse(payload);
}

function requireSession(request: FastifyRequest, reply: FastifyReply): SessionRecord | null {
  const session = request.context.session;
  if (!session) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return session;
}

function verifySameOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  const referer = request.headers.referer;
  if (origin && !config.allowedOrigins.includes(origin)) {
    throw new HttpError(403, 'Origin mismatch');
  }
  if (!origin && referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (!config.allowedOrigins.includes(refererOrigin)) {
        throw new HttpError(403, 'Referer mismatch');
      }
    } catch {
      throw new HttpError(403, 'Invalid referer');
    }
  }
}

function verifyCsrf(request: FastifyRequest, session: SessionRecord): void {
  const headerToken = request.headers[CSRF_HEADER] as string | undefined;
  if (!headerToken || headerToken !== session.csrfToken) {
    throw new HttpError(403, 'Missing or invalid CSRF token');
  }
}

function consumeActionRateLimit(request: FastifyRequest): void {
  const key = `${getRemoteAddress(request)}:${request.method}:${request.url}`;
  const result = actionRateLimiter.consume(key);
  if (!result.allowed) {
    throw new HttpError(429, 'Too many actions. Retry later.');
  }
}

async function requireAuthenticatedMutation(request: FastifyRequest, reply: FastifyReply): Promise<SessionRecord | null> {
  const session = requireSession(request, reply);
  if (!session) {
    return null;
  }
  verifySameOrigin(request);
  verifyCsrf(request, session);
  consumeActionRateLimit(request);
  return session;
}

app.addHook('preHandler', async (request) => {
  const sessionId = request.cookies[SESSION_COOKIE];
  const session = authSessionStore.touch(sessionId);
  request.context = { session };
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    reply.status(400).send({
      error: 'Invalid request payload',
      details: error.flatten(),
    });
    return;
  }
  if (error instanceof HttpError) {
    reply.status(error.statusCode).send({
      error: error.message,
    });
    return;
  }
  requestLogSafe(error);
  reply.status(500).send({ error: 'Internal server error' });
});

function requestLogSafe(error: unknown): void {
  app.log.error(error);
}

app.get('/api/config', async (_request, reply) => {
  reply.send({
    appName: 'JunimoServer Control',
    secureProxy: true,
    allowedReadKeys,
    baseUrlHint: new URL(config.JUNIMO_BASE_URL).origin,
    documentationUrl: 'https://stardew-valley-dedicated-server.github.io/server/features/rest-api.html',
  });
});

app.get('/api/auth/session', async (request, reply) => {
  const session = request.context.session;
  reply.send({
    authenticated: Boolean(session),
    csrfToken: session?.csrfToken ?? null,
    expiresAt: session?.expiresAt ?? null,
  });
});

app.post('/api/auth/login', async (request, reply) => {
  verifySameOrigin(request);
  const body = loginBodySchema.parse(request.body);
  const remote = getRemoteAddress(request);
  const rateResult = loginRateLimiter.consume(remote);
  if (!rateResult.allowed) {
    reply.code(429).send({ error: 'Too many login attempts. Retry later.' });
    return;
  }

  if (body.password !== config.ADMIN_PASSWORD) {
    reply.code(401).send({ error: 'Invalid credentials' });
    return;
  }

  loginRateLimiter.clear(remote);
  const existing = request.cookies[SESSION_COOKIE];
  authSessionStore.delete(existing);
  const session = authSessionStore.create();
  setSessionCookie(reply, session);
  reply.send({
    authenticated: true,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  });
});

app.post('/api/auth/logout', async (request, reply) => {
  const session = requireSession(request, reply);
  if (!session) {
    return;
  }
  verifySameOrigin(request);
  verifyCsrf(request, session);
  authSessionStore.delete(session.id);
  clearSessionCookie(reply);
  reply.send({ success: true });
});

app.get('/api/dashboard', async (request, reply) => {
  const session = requireSession(request, reply);
  if (!session) {
    return;
  }

  const { diagnostics } = dashboardQuerySchema.parse(request.query);
  const tasks: Array<Promise<unknown>> = [
    fetchJunimoJson(readEndpoints.status.path, { method: 'GET' }, readEndpoints.status.parser),
    fetchJunimoJson(readEndpoints.players.path, { method: 'GET' }, readEndpoints.players.parser),
    fetchJunimoJson(readEndpoints.inviteCode.path, { method: 'GET' }, readEndpoints.inviteCode.parser),
    fetchJunimoJson(readEndpoints.health.path, { method: 'GET' }, readEndpoints.health.parser),
    fetchJunimoJson(readEndpoints.stats.path, { method: 'GET' }, readEndpoints.stats.parser),
    fetchJunimoJson(readEndpoints.farmhands.path, { method: 'GET' }, readEndpoints.farmhands.parser),
    fetchJunimoJson(readEndpoints.settings.path, { method: 'GET' }, readEndpoints.settings.parser),
    fetchJunimoJson(readEndpoints.cabins.path, { method: 'GET' }, readEndpoints.cabins.parser),
    fetchJunimoJson(readEndpoints.rendering.path, { method: 'GET' }, readEndpoints.rendering.parser),
    fetchJunimoJson(readEndpoints.screenshot.path, { method: 'GET' }, readEndpoints.screenshot.parser),
    fetchJunimoJson(readEndpoints.auth.path, { method: 'GET' }, readEndpoints.auth.parser),
  ];

  if (diagnostics) {
    tasks.push(
      fetchJunimoJson(readEndpoints.diagnostics.path, { method: 'GET' }, readEndpoints.diagnostics.parser),
    );
  }

  const results = await Promise.all(tasks);
  const [
    status,
    players,
    inviteCode,
    health,
    stats,
    farmhands,
    settings,
    cabins,
    rendering,
    screenshot,
    auth,
    diagnosticsState,
  ] = results;

  reply.send({
    status,
    players,
    inviteCode,
    health,
    stats,
    farmhands,
    settings,
    cabins,
    rendering,
    screenshot,
    auth,
    diagnostics: diagnostics ? diagnosticsState : null,
  });
});

app.get('/api/read/:key', async (request, reply) => {
  const session = requireSession(request, reply);
  if (!session) {
    return;
  }
  const params = z
    .object({
      key: z.enum(allowedReadKeys as [typeof allowedReadKeys[number], ...typeof allowedReadKeys[number][]]),
    })
    .parse(request.params);
  const endpoint = readEndpoints[params.key];
  const data = await fetchJunimoJson<unknown>(endpoint.path, { method: 'GET' }, endpoint.parser as z.ZodType<unknown>);
  reply.send(data);
});

const MAP_URL_HEADER = 'x-map-api-url';

app.get('/api/map/saves', async (request, reply) => {
  const session = requireSession(request, reply);
  if (!session) return;
  const mapUrl = request.headers[MAP_URL_HEADER] as string;
  if (!mapUrl) {
    reply.code(400).send({ error: 'Missing x-map-api-url header' });
    return;
  }
  const data = await fetchJunimoJson('/saves', { method: 'GET' }, z.any(), mapUrl);
  reply.send(data);
});

app.get('/api/map/saves/:slot/farm', async (request, reply) => {
  const session = requireSession(request, reply);
  if (!session) return;
  const mapUrl = request.headers[MAP_URL_HEADER] as string;
  if (!mapUrl) {
    reply.code(400).send({ error: 'Missing x-map-api-url header' });
    return;
  }
  const params = z.object({ slot: z.string() }).parse(request.params);
  const data = await fetchJunimoJson(`/saves/${params.slot}/farm`, { method: 'GET' }, z.any(), mapUrl);
  reply.send(data);
});

app.post('/api/map/refresh', async (request, reply) => {
  const session = await requireAuthenticatedMutation(request, reply);
  if (!session) return;
  const mapUrl = request.headers[MAP_URL_HEADER] as string;
  if (!mapUrl) {
    reply.code(400).send({ error: 'Missing x-map-api-url header' });
    return;
  }
  const data = await fetchJunimoJson('/refresh', { method: 'POST' }, z.any(), mapUrl);
  reply.send(data);
});

app.post('/api/map/saves/:slot/refresh', async (request, reply) => {
  const session = await requireAuthenticatedMutation(request, reply);
  if (!session) return;
  const mapUrl = request.headers[MAP_URL_HEADER] as string;
  if (!mapUrl) {
    reply.code(400).send({ error: 'Missing x-map-api-url header' });
    return;
  }
  const params = z.object({ slot: z.string() }).parse(request.params);
  const data = await fetchJunimoJson(`/saves/${params.slot}/refresh`, { method: 'POST' }, z.any(), mapUrl);
  reply.send(data);
});

app.post('/api/actions/auth-timeout', async (request, reply) => {
  const session = await requireAuthenticatedMutation(request, reply);
  if (!session) {
    return;
  }
  const body = setAuthTimeoutInputSchema.parse(request.body);
  const data = await fetchJunimoJson(
    `/auth/timeout?value=${body.value}`,
    { method: 'POST' },
    authTimeoutResponseSchema,
  );
  reply.send(data);
});

app.post('/api/actions/rendering', async (request, reply) => {
  const session = await requireAuthenticatedMutation(request, reply);
  if (!session) {
    return;
  }
  const body = setRenderingInputSchema.parse(request.body);
  const data = await fetchJunimoJson(
    `/rendering?fps=${body.fps}`,
    { method: 'POST' },
    renderingSetResponseSchema,
  );
  reply.send(data);
});

app.post('/api/actions/time', async (request, reply) => {
  const session = await requireAuthenticatedMutation(request, reply);
  if (!session) {
    return;
  }
  const body = setTimeInputSchema.parse(request.body);
  const data = await fetchJunimoJson(
    `/time?value=${body.value}`,
    { method: 'POST' },
    timeSetResponseSchema,
  );
  reply.send(data);
});

app.post('/api/actions/clock-speed', async (request, reply) => {
  const session = await requireAuthenticatedMutation(request, reply);
  if (!session) {
    return;
  }
  const body = setClockSpeedInputSchema.parse(request.body);
  const data = await fetchJunimoJson(
    `/clock-speed?multiplier=${encodeURIComponent(body.multiplier.toString())}`,
    { method: 'POST' },
    clockSpeedResponseSchema,
  );
  reply.send(data);
});

app.post('/api/actions/grant-admin', async (request, reply) => {
  const session = await requireAuthenticatedMutation(request, reply);
  if (!session) {
    return;
  }
  const body = roleGrantInputSchema.parse(request.body);
  const query = body.name
    ? `name=${encodeURIComponent(body.name)}`
    : `playerId=${body.playerId}`;
  const data = await fetchJunimoJson(`/roles/admin?${query}`, { method: 'POST' }, roleGrantResponseSchema);
  reply.send(data);
});

app.delete('/api/actions/farmhand', async (request, reply) => {
  const session = await requireAuthenticatedMutation(request, reply);
  if (!session) {
    return;
  }
  const body = deleteFarmhandInputSchema.parse(request.body);
  const query = body.name
    ? `name=${encodeURIComponent(body.name)}`
    : `playerId=${body.playerId}`;
  const data = await fetchJunimoJson(`/farmhands?${query}`, { method: 'DELETE' }, farmhandResponseSchema);
  reply.send(data);
});

app.post('/api/actions/new-game', async (request, reply) => {
  const session = await requireAuthenticatedMutation(request, reply);
  if (!session) {
    return;
  }
  const body = newGameRequestSchema.parse(request.body);
  const data = await fetchJunimoJson(
    '/newgame',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    newGameResponseSchema,
  );
  reply.send(data);
});

app.post('/api/actions/reload', async (request, reply) => {
  const session = await requireAuthenticatedMutation(request, reply);
  if (!session) {
    return;
  }
  reloadWorldInputSchema.parse(request.body);
  const data = await fetchJunimoJson('/reload', { method: 'POST' }, reloadResponseSchema);
  reply.send(data);
});

app.get('/api/ws/token', async (request, reply) => {
  const session = requireSession(request, reply);
  if (!session) {
    return;
  }
  reply.send({
    websocketUrl: `/api/ws`,
    token: session.csrfToken,
  });
});

app.get('/api/ws', { websocket: true }, async (socket, request) => {
  const session = request.context.session;
  if (!session) {
    socket.close(4401, 'Unauthorized');
    return;
  }

  const origin = request.headers.origin;
  if (origin && !config.allowedOrigins.includes(origin)) {
    socket.close(4403, 'Origin mismatch');
    return;
  }

  const upstream = new WebSocket(new URL('/ws', config.JUNIMO_BASE_URL).toString());

  let upstreamOpen = false;
  let authenticated = false;

  upstream.addEventListener('open', async () => {
    upstreamOpen = true;
    try {
      const authPayload = JSON.stringify({
        type: 'auth',
        payload: { token: config.JUNIMO_API_KEY },
      });
      upstream.send(authPayload);
    } catch (error) {
      app.log.error(error);
      socket.close(1011, 'Upstream auth failed');
    }
  });

  upstream.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : event.data.toString();
    try {
      const parsed = JSON.parse(raw) as { type?: string };
      if (parsed.type === 'auth_success') {
        authenticated = true;
      }
    } catch {
      // ignore parse errors; still relay.
    }

    if (socket.readyState === socket.OPEN) {
      socket.send(raw);
    }
  });

  upstream.addEventListener('close', (event) => {
    if (socket.readyState === socket.OPEN) {
      socket.close(event.code || 1000, event.reason || 'Upstream closed');
    }
  });

  upstream.addEventListener('error', (error) => {
    app.log.error(error);
    if (socket.readyState === socket.OPEN) {
      socket.close(1011, 'Upstream error');
    }
  });

  socket.on('message', (message: Buffer) => {
    if (!upstreamOpen) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.toString());
    } catch {
      socket.send(JSON.stringify({ type: 'error', payload: { error: 'Invalid JSON' } }));
      return;
    }

    const chatMessageSchema = z.object({
      type: z.literal('chat_send'),
      csrfToken: z.string(),
      payload: z.object({
        author: z.string().trim().min(1).max(40),
        message: z.string().trim().min(1).max(500),
      }),
    });

    const heartbeatSchema = z.object({
      type: z.literal('ping'),
      csrfToken: z.string(),
    });

    const chatMatch = chatMessageSchema.safeParse(parsed);
    if (chatMatch.success) {
      if (chatMatch.data.csrfToken !== session.csrfToken) {
        socket.send(JSON.stringify({ type: 'error', payload: { error: 'CSRF mismatch' } }));
        return;
      }
      if (!authenticated) {
        socket.send(JSON.stringify({ type: 'error', payload: { error: 'Upstream auth not ready' } }));
        return;
      }
      upstream.send(
        JSON.stringify({
          type: 'chat_send',
          payload: chatMatch.data.payload,
        }),
      );
      return;
    }

    const heartbeatMatch = heartbeatSchema.safeParse(parsed);
    if (heartbeatMatch.success) {
      socket.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    socket.send(JSON.stringify({ type: 'error', payload: { error: 'Unsupported message type' } }));
  });

  socket.on('close', () => {
    if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) {
      upstream.close();
    }
  });
});

if (config.NODE_ENV === 'production') {
  app.get('/*', async (request, reply) => {
    const url = request.url;
    if (url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    return reply.sendFile('index.html');
  });
}

setInterval(() => {
  authSessionStore.sweep();
  loginRateLimiter.sweep();
  actionRateLimiter.sweep();
}, 60_000).unref();

await app.listen({
  port: config.PORT,
  host: config.HOST,
});
