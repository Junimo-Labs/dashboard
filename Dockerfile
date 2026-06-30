FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci --registry=https://registry.npmjs.org/

COPY . .
RUN npm run build

FROM caddy:2.8.4-alpine

RUN apk add --no-cache bash jq

WORKDIR /srv

COPY --from=build /app/dist/client /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/docker-entrypoint.sh /usr/local/bin/junimo-web-entrypoint.sh

RUN chmod +x /usr/local/bin/junimo-web-entrypoint.sh

ENV WEBUI_TITLE="JunimoServer Control" \
    JUNIMO_DEFAULT_API_BASE_URL="" \
    JUNIMO_DOCUMENTATION_URL="https://stardew-valley-dedicated-server.github.io/server/features/rest-api.html"

EXPOSE 80

ENTRYPOINT ["/usr/local/bin/junimo-web-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
