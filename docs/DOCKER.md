# Docker setup

The application consists of a React/Vite frontend and a Python/FastAPI backend. The built frontend runs behind non-root Nginx. No database, Redis service, training job, or extra queue is required by the current application.

## Quick start

Requirements: Docker Engine with Compose v2.20+ or Docker Desktop, internet access for the first build, and a browser with WebGL support. Linux amd64 and arm64 images are supported by the selected base images and dependencies. The browser, not the containers, renders the stadium, so containers do not require a GPU.

From the repository root:

```bash
docker compose config --quiet
docker compose up --build --wait
docker compose ps
```

Open http://localhost:8080. API documentation is at http://localhost:8080/docs. `--wait` starts the services in the background and waits for their health checks. Initial image/dependency downloads can take several minutes.

The frontend serves static assets and proxies `/api/*` and `/ws/*` to `backend:8000` on the private Compose network. The browser must never address `http://backend:8000` because that name exists only inside Docker. `/api/health` proxies the backend's `/health`; the frontend's own liveness route is `/health`. Swagger's schema is available at `/openapi.json`.

The old ports 5173 and 8000 remain available to separately launched local development servers. Docker publishes only port 8080 by default, bound to `127.0.0.1`.

## Verify the full connection

```bash
docker compose run --rm smoke
```

This optional tool service checks the built UI and its JavaScript bundle, both health routes, REST, both WebSocket endpoints, all 4,000 identities, eight gates, persistent congestion, closed-gate rerouting, zone forecasts, and run export. It uses deterministic synthetic contract inputs against the actual Python service, not mocked network responses. It is a connectivity/regression test, not a physical evacuation benchmark.

The test adds one uniquely named run to the bounded in-memory registry. It does not reset the shared simulation, approve an intervention, generate datasets, train models, or evaluate expensive counterfactual rollouts. Run it against the built stack, not the Vite development server, because it also verifies production assets.

With Node 22+ installed, the same check can run from the host:

```bash
node scripts/docker-smoke.mjs http://localhost:8080
```

An additional real-browser check verifies the unchanged stadium canvas, live Python responses, and closing/reopening Gate D through the UI. With frontend dependencies and Playwright Chromium installed on the host, run from `frontend/`:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:8080 npm run test:e2e -- docker.spec.ts --workers=1
```

`PLAYWRIGHT_BASE_URL` points the test at an existing stack and disables Playwright's automatic local Vite server. The test uses real HTTP/WebSocket connections, saves a screenshot under ignored `frontend/test-results/`, and starts one isolated simulation run. It can also verify the development stack's address.

## Configuration

Defaults work without an environment file. For persistent local changes, copy the root `.env.example` to `.env` and edit it:

```bash
cp .env.example .env
```

`FRONTEND_PORT` changes the published host port. `BIND_ADDRESS` defaults to loopback. For a one-off alternate port:

```bash
FRONTEND_PORT=8081 docker compose up --build --wait
```

The root `.env` configures Compose. `frontend/.env` configures a locally launched Vite server, not the built Docker frontend. Environment files, the Git repository, local dependencies, generated data, and pitch assets are excluded from the Docker build context.

Keep `VITE_API_URL` and `VITE_CONGESTION_WS_URL` blank for the bundled same-origin proxy. Compose passes optional overrides as frontend **build arguments**, and Vite embeds them into public JavaScript. Rebuild after changing them; setting runtime container variables cannot rewrite a compiled bundle. Never put secrets in `VITE_*` values. External origins require separate backend CORS configuration, so they are not needed for this stack.

For direct Docker builds, `frontend/Dockerfile` accepts `NODE_IMAGE` and `NGINX_IMAGE` arguments. Use maintained image tags or reviewed digests and rebuild regularly to receive OS security fixes. Application dependencies are reproducible through `frontend/package-lock.json` and the hash-pinned backend requirements files; base-image tags intentionally receive patch updates.

To update Python dependencies deliberately, use Python 3.12 in an isolated environment with `pip-tools==7.5.2`, then run from the repository root:

```bash
python -m piptools compile --extra ml --generate-hashes --strip-extras --upgrade --output-file backend/requirements.txt backend/pyproject.toml
python -m piptools compile --extra ml --extra dev --constraint backend/requirements.txt --generate-hashes --strip-extras --output-file backend/requirements-dev.txt backend/pyproject.toml
```

Review and commit both lock files together, rebuild, and run the tests. Frontend dependency changes must include the updated `package-lock.json`.

## Development with hot reload

Stop the built stack first if using the same host port:

```bash
docker compose down
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build --wait
```

The development stack uses project `northstar-dev`, development images, and a separate data volume. It exposes the same http://localhost:8080 address. React source and shared geometry are mounted read-only into Vite; Python app and script source are mounted read-only into Uvicorn. Host edits trigger hot reload. Dependencies stay inside images, so host `node_modules` and virtual environments are never mounted over Linux dependencies.

Vite proxies to `http://backend:8000`. The development configuration forces blank browser endpoint overrides so it cannot accidentally target a host-only API. Python's file watcher uses polling for Docker Desktop bind mounts. Rebuild after changing package manifests, dependency locks, Dockerfiles, or build configuration not mounted by the override.

Run tests inside the development images:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm --no-deps backend python -m pytest -p no:cacheprovider
docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm --no-deps backend ruff check app tests scripts
docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm --no-deps frontend npm test
```

Both tests run in disposable containers. They do not require the application servers to be running, but development images must first be built using the command above. Frontend production compilation is also checked during the normal runtime image build.

## Data, models, and process state

The backend image preserves the repository's directory contract:

```text
/app/backend/app        API and algorithms, baked into the runtime image
/app/backend/scripts    optional baseline/dataset/training CLIs
/app/shared             shared stadium geometry
/app/data               persistent named volume
  generated/            generated datasets
  models/               optional trained models
  exports/              optional file outputs
```

The container creates `/app/data` as UID/GID `10001:10001`, which owns the initial named volume. No host permission changes are needed. Host files under the repository's `data/` directory are not copied automatically into the image or volume.

Live runs, approved plans, and the legacy simulation state are process memory. They do **not** become durable just because the data volume exists. A backend restart discards them. Export a run through the UI/API before restarting if you need its history. Browser downloads save to the host browser's download location, not `/app/data`.

Use exactly one backend replica and one Uvicorn worker. Scaling without a shared state store can send a run's HTTP and WebSocket requests to different process-local registries.

The runtime includes optional ML dependencies but never trains on startup. With no model, forecasting uses the deterministic baseline. A model at `/app/data/models/zone_forecaster_v1.joblib` is loaded when the service starts. Only load a trusted model: joblib/pickle files can execute code.

Stream a trusted existing model into the volume as the application's own user, then restart:

```bash
docker compose exec -T backend python -c "import sys; from pathlib import Path; Path('/app/data/models/zone_forecaster_v1.joblib').write_bytes(sys.stdin.buffer.read())" < data/models/zone_forecaster_v1.joblib
docker compose restart backend
```

The stdin copy avoids creating root-owned model files in the data volume. It replaces that exact model file, so back up any existing model first. Reload or reset the UI after a backend restart to begin a new run.

The baseline CLI is available without installing Python on the host:

```bash
docker compose exec backend python -m scripts.run_baseline --steps 8
```

Dataset generation and training remain explicit offline actions. They are not part of `up`, health checks, or smoke testing. They consume CPU and can compete with a live demonstration, so run them separately when intended.

Back up the complete data volume to an ignored local directory:

```bash
mkdir -p data/backups
docker compose cp backend:/app/data data/backups/northstar-data
```

## Logs and lifecycle

```bash
docker compose logs -f --tail=100
docker compose restart backend
docker compose up --build --wait
docker compose stop
docker compose start --wait
docker compose down
```

Logs rotate at 10 MB with three files per application service. `stop` preserves containers. `down` removes this project's containers and network but preserves its data volume. Avoid `down --volumes` unless you intentionally want to permanently delete generated datasets and models.

For the development stack, add `-f docker-compose.yml -f docker-compose.dev.yml` to lifecycle commands. Running plain `docker compose down` affects the built stack, not the separate development project.

## Troubleshooting and boundaries

- **Cannot connect to Docker:** start Docker Desktop or your Docker daemon. On supported Docker Desktop versions, `docker desktop start` is available.
- **Port already allocated:** choose another `FRONTEND_PORT`, or stop the stack that owns that port. Do not stop unrelated services.
- **Backend unhealthy:** inspect `docker compose logs backend`. Confirm the image includes `/app/shared/stadium-config.json` and that any mounted model is compatible and trusted.
- **Detector unavailable / HTTP 502:** check `/api/health`, backend logs, and browser network requests. Browser requests should use port 8080, not port 8000. Nginx re-resolves Docker DNS after backend recreation; existing sockets disconnect and the client reconnects.
- **Changed dependencies not appearing:** rebuild the relevant image. Do not copy macOS/Windows `node_modules` or virtual environments into Linux containers.
- **Wrong frontend endpoint:** clear old `.env` overrides and rebuild. Vite public configuration is compiled into the assets.
- **Need LAN access:** deliberately set `BIND_ADDRESS=0.0.0.0`, configure the host firewall, and consider who can access the machine. This app has no authentication or authorization layer.
- **Internet deployment:** this is a hardened container packaging setup, not a certified or fully secured public service. Add HTTPS termination, authentication/authorization, rate limits, and appropriate operational controls before exposing it publicly. Do not expose the backend directly. Same-origin HTTPS makes the browser choose secure WebSockets automatically.

Implementation references: [Compose readiness](https://docs.docker.com/compose/how-tos/startup-order/), [Compose deployment guidance](https://docs.docker.com/compose/how-tos/production/), [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html), and [unprivileged Nginx runtime paths](https://github.com/nginx/docker-nginx-unprivileged).
