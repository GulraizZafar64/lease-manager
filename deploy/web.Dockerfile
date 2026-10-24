# The web app, built to use the API, served by Caddy (see Caddyfile). Build context: ../frontend
FROM node:20.17.0-bookworm-slim AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV VITE_USE_API=true
RUN npm run build

FROM caddy:2.8.4
COPY --from=build /web/dist /srv
