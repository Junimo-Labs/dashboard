# JunimoServer-Web Architecture Overview

## 1. Project Overview
JunimoServer-Web is a full-stack web administration panel designed for Stardew Valley dedicated servers running the JunimoServer API. 
The architecture consists of a React/Vite frontend (Single Page Application) and a Fastify (Node.js) backend acting as a secure proxy.

- **Frontend (`src/client/`)**: A React 19 application built with Vite. It features a Stardew Valley-themed UI (using the `VT323` pixel font and custom CSS) with a tabbed layout (Dashboard, Map View, Controls, Chat Bridge). It never holds the upstream game server API key.
- **Backend (`src/server.ts` & `src/server/`)**: A Fastify Node.js server that securely proxies requests to the actual game server. It manages session-based authentication (via cookies), CSRF protection, rate limiting, and WebSocket relaying for the live chat bridge.
- **Shared (`src/shared/`)**: Zod schemas used by both frontend and backend to strictly validate API payloads and responses.

## 2. Build & Commands
The project uses `npm` for dependency management and scripts.

- **Development**:
  - `npm run dev`: Starts the Vite development server for the frontend.
  - *(Note: The Fastify backend must be run separately during development, usually via `node --loader ts-node/esm src/server.ts` or similar, depending on the local setup).*
- **Build**:
  - `npm run build`: Compiles the React frontend using Vite into the `dist/client/` directory.
- **Preview**:
  - `npm run preview`: Serves the built frontend locally for testing.
- **Type Checking**:
  - `npm run typecheck`: Runs TypeScript compiler without emitting files to verify types.
- **Deployment**:
  - The project provides a `Dockerfile` that builds the Node.js app and serves it using Caddy. 
  - `deploy/docker-entrypoint.sh` dynamically generates a `/config.js` at runtime using `jq` to inject environment variables (like `WEBUI_TITLE` and `JUNIMO_DEFAULT_API_BASE_URL`) into the browser context.

## 3. Code Style
- **TypeScript**: The codebase is strictly typed using TypeScript (`tsconfig.json` for client, `tsconfig.server.json` for server).
- **Validation**: `zod` is heavily used across the entire stack. Every API endpoint payload and upstream response is validated against Zod schemas defined in `src/shared/junimo.ts`.
- **UI Styling**: Uses plain CSS (`src/client/styles.css`) with CSS variables for theming. The current theme heavily relies on box-shadows to simulate pixel-art borders.
- **State Management**: React `useState` and `useRef` are used for local component state. Data fetching is handled via standard `fetch` with a custom wrapper (`api<T>`).

## 4. Testing
- There are no explicit testing frameworks (like Jest or Vitest) configured in the `package.json`. 
- Type safety and schema validation (TypeScript + Zod) serve as the primary correctness guarantees. 
- Any future testing should likely target Zod schema validation and Fastify endpoint routing.

## 5. Security
Security is a core focus of the backend architecture:
- **Zero-Trust Frontend**: The browser never sees the upstream `JUNIMO_API_KEY`. It authenticates with the Fastify proxy using a password.
- **Session & CSRF**: Uses HTTP-only, secure cookies for session tracking (`@fastify/cookie`). Every state-mutating request (POST/DELETE) and WebSocket connection requires a valid `x-csrf-token` header.
- **Rate Limiting**: Custom in-memory rate limiters (`src/server/auth.ts`) protect the `/api/auth/login` endpoint from brute force and generic `/api/actions/*` from spam.
- **Origin Validation**: Strict CORS and Referer/Origin header checking (`verifySameOrigin`) prevents cross-site request forgery.
- **Payload Validation**: All inputs are sanitized and validated using Zod before being processed or forwarded.

## 6. Configuration
Configuration is managed via environment variables (loaded via `dotenv` in Node.js and injected via `config.js` in the browser).

Key backend variables (`src/server/config.ts`):
- `NODE_ENV`: 'development' or 'production'.
- `PORT` / `HOST`: Server binding.
- `ADMIN_PASSWORD`: Required to access the WebUI.
- `JUNIMO_BASE_URL`: URL of the upstream game server.
- `JUNIMO_API_KEY`: API key for the upstream game server.
- `SESSION_SECRET`: Secret for signing cookies.
- `ALLOWED_ORIGINS`: Comma-separated list of allowed CORS origins.

Key frontend variables (injected at runtime via Docker entrypoint):
- `WEBUI_TITLE`: The title displayed on the login screen.
- `JUNIMO_DOCUMENTATION_URL`: Link to the API documentation.
- `JUNIMO_DEFAULT_API_BASE_URL`: Base URL hint for the UI.

## 7. 审美要求

你是一名资深前端工程师兼 UI/UX 设计师。请为这个页面实现一个现代、精致、交互友好的前端界面。

设计目标：

* 页面要有现代 SaaS / 管理后台 / 工具型产品的质感。
* 视觉风格干净、克制、有层次，避免默认 HTML 样式。
* 信息层级清晰，用户一眼能理解页面重点。
* 交互反馈自然，按钮、输入框、卡片、状态变化都要有细节。

视觉要求：

* 使用统一的间距系统，例如 4 / 8 / 12 / 16 / 24 / 32px。
* 使用清晰的字体层级：标题、副标题、正文、辅助说明要明显区分。
* 使用卡片、阴影、圆角、边框、背景色来建立层次。
* 主色调不超过 1～2 个，辅助色用于状态提示。
* 避免大面积高饱和颜色，整体风格偏高级、简洁。
* 页面需要有合适的留白，不要拥挤。

布局要求：

* 优先采用响应式布局，桌面端和移动端都要可用。
* 重要内容放在首屏明显位置。
* 表单、列表、按钮、操作区要对齐整齐。
* 对复杂内容使用分组、卡片、Tabs、折叠面板或分栏布局。

交互要求：

* 所有可点击元素都要有 hover / active / disabled 状态。
* 表单输入要有 focus 状态、错误提示、占位提示和必要的说明。
* 异步操作要有 loading 状态，避免用户不知道发生了什么。
* 操作成功或失败要有明确反馈，例如 toast、inline alert 或状态文案。
* 危险操作需要二次确认或明显的危险色提示。
* 空状态、错误状态、加载状态都要设计完整。

组件要求：

* 不要直接堆 HTML 元素，要拆成可维护的组件。
* 组件命名清晰，结构合理。
* 样式要统一，不要每个组件各写一套风格。
* 如果使用 Tailwind CSS，请充分利用 utility class 做出现代 UI，而不是只写基础布局。
* 如果使用组件库，也要进行适度定制，避免看起来像默认模板。

细节要求：

* 按钮、卡片、输入框、弹窗、表格、列表都要有精细样式。
* 图标可以增强理解，但不要滥用。
* 数字、状态、关键指标要有视觉强调。
* 页面动效要轻量，例如 transition、hover shadow、fade，不要过度动画。
* 深色模式如项目支持，也要考虑对比度和层次。

代码要求：

* 保持代码简洁、可读、可维护。
* 不要写死大量重复样式，必要时抽象公共 class 或组件。
* 保证无明显布局错位、溢出、遮挡。
* 保证基础可访问性：按钮可聚焦，颜色对比足够，表单 label 清晰。

验收标准：

* 页面不能像“默认浏览器样式”或“工程师临时页面”。
* 首屏要有明确视觉重点。
* 所有主要交互都有反馈。
* 移动端不会崩。
* 空状态、加载状态、错误状态都有对应 UI。
* 整体效果应接近现代商业产品，而不是 demo 页面。

不要生成简陋的 demo 页面。不要只使用默认按钮、默认 input、默认 table。不要把所有内容堆在一个白色页面里。不要只关注功能可用，也要主动补全视觉层次、交互反馈、响应式、空状态、加载状态和错误状态。
