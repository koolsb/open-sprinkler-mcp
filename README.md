# OpenSprinkler MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects AI assistants to an [OpenSprinkler](https://opensprinkler.com) irrigation controller. Ask Claude to check your watering schedule, run a station, review history, or manage rain delays — all through natural language.

## Table of Contents

- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Running with Docker](#running-with-docker)
- [Running with Docker Compose](#running-with-docker-compose)
- [Deploying to Kubernetes](#deploying-to-kubernetes)
- [Connecting to Claude](#connecting-to-claude)
- [Tools Reference](#tools-reference)
- [Versioning](#versioning)
- [Development](#development)
- [Testing](#testing)

---

## Requirements

- An [OpenSprinkler](https://opensprinkler.com) device running firmware 2.2.1 or later
- Docker (for container deployment) or Node.js 22+ (for local development)
- An MCP-compatible client (Claude Desktop, Claude Code, etc.)

---

## Quick Start

```bash
docker run -p 3000:3000 \
  -e OS_HOST=192.168.1.100 \
  -e OS_PASSWORD=opendoor \
  ghcr.io/koolsb/open-sprinkler-mcp:latest
```

The server will be available at `http://localhost:3000/mcp`.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OS_HOST` | **Yes** | — | Hostname, IP address, or URL of your OpenSprinkler device (e.g. `192.168.1.100`, `sprinkler.local`, or `http://192.168.1.100`) |
| `OS_PASSWORD` | **Yes** | — | Plain-text device password. The default OpenSprinkler password is `opendoor`. The server MD5-hashes it before every API call. |
| `OS_READ_ONLY` | No | `false` | Set to `true` or `1` to expose only read-only monitoring tools. All write/control tools are omitted from the server entirely. Useful for shared or untrusted environments. |
| `PORT` | No | `3000` | TCP port for the **internal** listener (no authentication). |

---

## Authentication (optional OAuth)

By default the server listens on `PORT` with **no authentication** — the right choice
for a private, in-cluster deployment where network policy already restricts access.

To expose the server publicly (e.g. as a remote MCP connector for Claude), set
`AUTH_ISSUER`. When it is set, the server starts a **second listener** on `PUBLIC_PORT`
that acts as an OAuth 2.0 **resource server**: it requires a valid Bearer JWT issued by
your authorization server (e.g. Authentik), verifies it against the issuer's JWKS, and
serves protected-resource metadata for OAuth discovery. The internal `PORT` listener is
unchanged, so in-cluster clients keep connecting without OAuth.

Point Claude (or any MCP client) at `https://<host>/mcp` on the public listener; it will
discover the authorization server, run the OAuth login, and call the server with a token.

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTH_ISSUER` | No | — | OAuth/OIDC issuer URL. **Setting this enables the authenticated public listener.** Must match the token `iss` claim exactly (e.g. `https://auth.example.com/application/o/open-sprinkler-mcp/`). |
| `MCP_RESOURCE_URL` | If `AUTH_ISSUER` set | — | This server's public resource identifier, e.g. `https://open-sprinkler.mcp.example.com`. Advertised in resource metadata and expected as the token `aud`. |
| `AUTH_AUDIENCE` | No | `MCP_RESOURCE_URL` | Expected `aud` claim, if it differs from the resource URL. |
| `AUTH_JWKS_URI` | No | *(from discovery)* | JWKS endpoint. Derived from the issuer's OIDC discovery document when omitted. |
| `AUTH_REQUIRED_SCOPES` | No | *(none)* | Space/comma-separated scopes the token must carry. |
| `AUTH_ALLOWED_GROUPS` | No | *(none)* | **Comma-separated** group names (a name may contain spaces, e.g. `Kools.us Admins`); if set, the token's `groups` claim must include at least one. Requires the authorization server to emit a `groups` claim. |
| `PUBLIC_PORT` | No | `3001` | TCP port for the authenticated public listener (only started when `AUTH_ISSUER` is set). |

---

## Running with Docker

```bash
# Pull and run
docker run -d \
  --name open-sprinkler-mcp \
  --restart unless-stopped \
  -p 3000:3000 \
  -e OS_HOST=192.168.1.100 \
  -e OS_PASSWORD=opendoor \
  ghcr.io/koolsb/open-sprinkler-mcp:latest

# Read-only mode (monitoring only, no control)
docker run -d \
  --name open-sprinkler-mcp \
  -p 3000:3000 \
  -e OS_HOST=192.168.1.100 \
  -e OS_PASSWORD=opendoor \
  -e OS_READ_ONLY=true \
  ghcr.io/koolsb/open-sprinkler-mcp:latest

# Health check
curl http://localhost:3000/health
```

---

## Running with Docker Compose

1. Copy [`docker-compose.yml`](docker-compose.yml) and edit the environment variables:

```yaml
services:
  open-sprinkler-mcp:
    image: ghcr.io/koolsb/open-sprinkler-mcp:latest
    ports:
      - "3000:3000"
    environment:
      OS_HOST: "192.168.1.100"
      OS_PASSWORD: "opendoor"
    restart: unless-stopped
```

2. Start the server:

```bash
docker compose up -d
```

---

## Deploying to Kubernetes

A complete manifest is provided in [`k8s/deployment.yaml`](k8s/deployment.yaml), including a Deployment, Service, and Secret template.

**1. Create the secret** with your device credentials:

```bash
kubectl create secret generic open-sprinkler-mcp \
  --from-literal=OS_HOST=192.168.1.100 \
  --from-literal=OS_PASSWORD=opendoor
```

**2. Apply the manifest:**

```bash
kubectl apply -f k8s/deployment.yaml
```

The manifest deploys with:
- Resource requests/limits (50m–200m CPU, 64–128Mi memory)
- Liveness and readiness probes on `/health`
- A read-only root filesystem and non-root user
- `ClusterIP` service on port 3000

To expose externally, add an Ingress or change the Service type to `LoadBalancer`.

---

## Connecting to Claude

### Claude Code (CLI)

Add to your project's `.claude/mcp.json` or user-level MCP config:

```json
{
  "mcpServers": {
    "open-sprinkler": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "open-sprinkler": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

---

## Tools Reference

### Read-Only Tools

These tools are always available regardless of `OS_READ_ONLY`.

---

#### `get_controller_status`

Returns a summary of the controller's current state.

**Output includes:**
- Device time and firmware version
- Controller enabled/disabled state
- Active rain delay (with expiry time)
- Rain sensor state
- Weather adjustment percentage
- Sunrise and sunset times
- Last station run
- Current draw (mA) and hardware info

---

#### `get_stations`

Lists all configured irrigation stations.

**Output includes:**
- Station number and name
- Current state: `▶ Running`, `· Idle`, or `○ Disabled`
- Remaining runtime for running stations
- Source program for running stations
- Configuration flags: `MASTER`, `MASTER-2`, `IGNORE-RAIN`, `DISABLED`

---

#### `get_programs`

Lists all saved watering programs with full schedule details.

**Output includes:**
- Program name and enabled state
- Schedule type: Weekly, Single-run (specific date), Monthly, or Interval
- Active days (weekly), day-of-month, specific calendar date, or interval cadence
- Optional active date range (e.g. `Jan 1 – Mar 31`)
- Start times: up to 4 fixed times, or repeating mode (first start + interval + repeat count); supports sunrise/sunset-relative offsets (e.g. `Sunrise+15min`)
- Per-station durations (stations with 0s duration are omitted)
- Weather adjustment flag 

---

#### `get_options`

Returns the controller's configuration settings.

**Output includes:**
- Firmware and hardware version
- Device name and ID
- Timezone, NTP sync, DHCP/static IP
- Water level percentage
- Station delay between sequential runs
- Sequential vs. parallel mode
- Master station assignments
- Rain sensor type and configuration
- Logging state

---

#### `get_watering_history`

Returns a tabular log of past watering runs.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `days` | integer (1–365) | `7` | How many days of history to retrieve |

**Output includes:**
- Start time, station name, duration, and source (Program N / Manual / Run-Once) for each run
- Flow count if a flow sensor is installed
- Total watering time for the period

---

#### `get_queue_status`

Shows what is currently running or queued.

**Output includes:**
- Each active station: name, RUNNING/QUEUED state, remaining time, source program
- Last completed run details

---

#### `get_sensor_status`

Displays all sensor readings and weather sync state.

**Output includes:**
- Rain sensor state (if installed) and wiring type
- Secondary sensor type (rain, flow, or soil)
- Flow sensor count
- Active rain delay
- Current water level (weather adjustment %)
- Last successful and last attempted weather sync times

---

### Write Tools

These tools are only registered when `OS_READ_ONLY` is **not** set. They will not appear in the tool list at all when the server runs in read-only mode.

---

#### `run_station`

Starts a single station for a specified duration.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `station` | integer (≥ 1) | Station number (1-based) |
| `duration` | integer (1–64800) | Run duration in seconds (max 18 hours) |

---

#### `stop_station`

Stops a currently running station.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `station` | integer (≥ 1) | Station number (1-based) |

---

#### `stop_all_stations`

Immediately stops all running stations and clears the entire run queue.

No parameters.

---

#### `set_rain_delay`

Sets a rain delay that suspends all scheduled watering.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `hours` | integer (0–32767) | Delay in hours. Pass `0` to clear an existing delay. |

---

#### `set_controller_enabled`

Enables or disables the controller. When disabled, no watering runs — scheduled or manual.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `enabled` | boolean | `true` to enable, `false` to disable |

---

#### `reboot_controller`

Reboots the OpenSprinkler device. The controller will be offline for 10–30 seconds. The server handles the expected network drop gracefully.

No parameters.

---

#### `run_program`

Immediately executes a saved watering program.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `program` | integer (≥ 1) | — | Program number (1-based) |
| `use_weather_adjustment` | boolean | `false` | Scale station durations by the current weather adjustment percentage |

---

#### `set_queue_paused`

Pauses or resumes the run queue. While paused, active stations finish but no new ones start. Pass `duration=0` to resume.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `duration` | integer (0–86400) | Pause duration in seconds. `0` resumes immediately. |

---

#### `set_water_level`

Overrides the water level percentage used to scale all program durations.
- `100` = no change
- `50` = half the configured duration
- `150` = 1.5× the configured duration

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `level` | integer (0–250) | Water level percentage |

---

#### `run_once_program`

Runs a one-time custom watering sequence across any combination of stations without creating a permanent program.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `stations` | array | — | List of `{ station, duration }` objects. Set `duration: 0` to skip a station. |
| `use_weather_adjustment` | boolean | `false` | Apply current weather adjustment to all durations |

**Example:**
> "Water the front lawn for 10 minutes and the drip zone for 20 minutes."

---

## Versioning

This project uses **[Conventional Commits](https://www.conventionalcommits.org/)** and **[release-please](https://github.com/googleapis/release-please)** for automated versioning.

When commits are pushed to `main`, release-please opens (or updates) a release PR that bumps `package.json` and generates a `CHANGELOG.md` entry. Merging the release PR creates a `vX.Y.Z` tag, which triggers the Docker workflow to publish a new image.

### Commit Message Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer — BREAKING CHANGE: <description>]
```

| Prefix | Version bump | Example |
|---|---|---|
| `fix:` | patch (`1.0.0` → `1.0.1`) | `fix: handle empty station name` |
| `feat:` | minor (`1.0.0` → `1.1.0`) | `feat: add get_forecast tool` |
| `feat!:` or `BREAKING CHANGE:` footer | major (`1.0.0` → `2.0.0`) | `feat!: rename station parameter` |
| `docs:`, `chore:`, `test:`, `ci:`, `refactor:` | none | `docs: update K8s example` |

> Commits that don't match any of the above types are ignored by release-please.

---

## Development

### Prerequisites

- Node.js 22+
- npm

### Setup

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run locally (requires a real or reachable OpenSprinkler device)
OS_HOST=192.168.1.100 OS_PASSWORD=opendoor npm start

# Run in development mode (tsx, no compile step)
OS_HOST=192.168.1.100 OS_PASSWORD=opendoor npm run dev
```

### Project Structure

```
src/
  client.ts    — OpenSprinkler HTTP client (auth, request helpers, formatting)
  server.ts    — MCP server and all tool definitions
  index.ts     — Express HTTP server on port 3000

k8s/
  deployment.yaml   — Kubernetes Deployment, Service, and Secret template

Dockerfile           — Multi-stage Node 22 Alpine build
docker-compose.yml   — Local development compose file
.github/workflows/
  docker-publish.yml — Builds linux/amd64 + linux/arm64 images and pushes to GHCR
```

### Building the Docker Image Locally

```bash
docker build -t open-sprinkler-mcp .
docker run -p 3000:3000 -e OS_HOST=192.168.1.100 -e OS_PASSWORD=opendoor open-sprinkler-mcp
```

### GitHub Actions — Automatic Image Builds

Push to `main` or `master` to trigger an automatic build and push to GHCR. When release-please publishes a GitHub Release, a second build runs to produce semver-tagged images.

| Event | Tags |
|---|---|
| Push to `main` | `:latest`, `:main`, `:sha-<short>` |
| Release published (`v1.2.3`) | `:1.2.3`, `:1.2`, `:sha-<short>` |
| Pull request | Build only (no push) |

Images are built for both `linux/amd64` and `linux/arm64`.

---

## Testing

The test suite uses [Vitest](https://vitest.dev) and requires no running OpenSprinkler device — all API calls are mocked.

```bash
# Run all tests once
npm test

# Run in watch mode during development
npm run test:watch
```

### Test files

| File | Tests | What it covers |
|---|---|---|
| `tests/client.test.ts` | 43 | Utility functions and `apiGet` |
| `tests/tools.test.ts` | 42 | All 17 tool handlers end-to-end |
| `tests/write-guard.test.ts` | 8 | `OS_READ_ONLY` gating |

### `tests/client.test.ts` — utility functions and API client

Tests every pure helper in `src/client.ts` with no mocks:

- **`formatDuration`** — seconds/minutes/hours formatting, zero and negative inputs
- **`minutesToTimeStr`** — midnight, noon, AM/PM, minute padding, negative (disabled)
- **`decodeTimezone`** — UTC, positive and negative offsets, half-hour offsets (e.g. UTC+5:30)
- **`formatTimestamp`** — output shape, known Unix timestamp, zero/negative returns "Never"
- **`isStationRunning`** — per-board bitmask decoding across single and multi-board setups
- **`isBitSet`** — same bitmask pattern for disable/master/ignore-rain flags
- **`apiGet`** — URL construction (pw param, extra params), successful JSON response, array responses (e.g. `/jl`), HTTP errors, OpenSprinkler API result codes 2/16 and unknowns

### `tests/tools.test.ts` — tool handlers

Each tool is called through a real MCP `InMemoryTransport` + `Client` connection with `apiGet` mocked via `vi.mock`. Tests verify:

- **Output content** — formatted text contains expected station names, durations, states, and timestamps
- **API calls** — correct endpoint and parameters (including 1-based → 0-based station/program index conversion)
- **Error propagation** — `isError: true` is set and the error message is surfaced when `apiGet` throws
- **Edge cases** — empty history, reboot connection drop handled gracefully, `duration=0` resumes queue

### `tests/write-guard.test.ts` — `OS_READ_ONLY` gating

Uses `vi.resetModules()` + dynamic `import()` to re-evaluate the `WRITE_ENABLED` constant under different env var values:

| Scenario | Expected tool count |
|---|---|
| `OS_READ_ONLY` not set | 17 (all tools) |
| `OS_READ_ONLY=true` | 7 (read-only only) |
| `OS_READ_ONLY=1` | 7 (numeric form) |
| `OS_READ_ONLY=false` | 17 (explicit opt-out) |
