# IFRS 16 Lease Manager

Lease accounting under IFRS 16 for lessees and lessors. One installation serves many companies.

| Folder | What it is |
|---|---|
| [`backend/`](backend) | API server: Node.js 20, Fastify, PostgreSQL 16. Install, architecture and security notes are in its README. |
| [`frontend/`](frontend) | Web app: React, TypeScript, Vite. Runs on the backend's API, or on its own with data kept in the browser. |

## Run it locally

```bash
# Backend: database on 5433, API on 8090
cd backend
npm ci
cp .env.example .env        # then set DATABASE_URL, MASTER_KEY, PORT=8090, HOST=127.0.0.1 and COOKIE_SECURE=false:
                            # see backend/README.md, "Local development without Docker"
npm run db:dev              # terminal 1
npm run dev                 # terminal 2

# Web app on the API
cd frontend
npm ci
VITE_USE_API=true npx vite --port 5198
```

Open http://localhost:5198. Without `VITE_USE_API=true` the web app runs on its own and keeps its data in the browser.

## Put it online for free

[`deploy/`](deploy) runs the whole system on one free Oracle Cloud server with HTTPS: follow [deploy/README.md](deploy/README.md).
