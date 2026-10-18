#!/usr/bin/env node
/**
 * Verify the deployed stack through its public HTTP / WebSocket entry point.
 *
 * Usage: node scripts/docker-smoke.mjs [http://localhost:8080]
 * Requires Node.js 22+; no npm packages or browser are required.
 *
 * This submits synthetic contract fixtures to the real Python pipeline. It is
 * not a pedestrian simulation or a benchmark. One isolated smoke run remains
 * in the bounded, in-memory run registry; no shared simulation is reset, no
 * intervention is approved, and no training or counterfactual rollout is run.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const TIMEOUT_MS = 15_000;
const sockets = new Set();

function endpoint(base, path, websocket = false) {
  const url = new URL(path, base);
  if (websocket) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

async function request(base, path) {
  const response = await fetch(endpoint(base, path), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  });
  assert.equal(response.status, 200, `${path}: expected HTTP 200, received ${response.status}`);
  return response;
}

async function json(base, path) {
  const response = await request(base, path);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i,
    `${path}: expected JSON, not the SPA fallback`);
  return response.json();
}

/** Buffer messages immediately, including a server's welcome frame. */
async function connect(base, path) {
  const socket = new WebSocket(endpoint(base, path, true));
  sockets.add(socket);
  const queue = [];
  let pending;
  let failure;

  const fail = (error) => {
    failure = error;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = undefined;
    }
  };
  socket.addEventListener('message', (event) => {
    try {
      const value = JSON.parse(event.data);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(value);
        pending = undefined;
      } else {
        queue.push(value);
      }
    } catch (error) {
      fail(new Error(`${path}: invalid JSON message`, { cause: error }));
    }
  });
  socket.addEventListener('error', () => fail(new Error(`${path}: WebSocket transport failed`)));
  socket.addEventListener('close', (event) => {
    sockets.delete(socket);
    fail(new Error(`${path}: connection closed (${event.code}) before the expected message`));
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${path}: handshake timed out after ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    const finish = (error) => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onError);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = () => finish(failure ?? new Error(`${path}: handshake failed`));
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onError);
  });

  return {
    send(value) {
      assert.equal(socket.readyState, WebSocket.OPEN, `${path}: connection is not open`);
      socket.send(JSON.stringify(value));
    },
    receive() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (failure) return Promise.reject(failure);
      assert.equal(pending, undefined, `${path}: overlapping reads are not supported`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = undefined;
          reject(new Error(`${path}: response timed out after ${TIMEOUT_MS} ms`));
        }, TIMEOUT_MS);
        pending = { resolve, reject, timer };
      });
    },
    close() {
      socket.close(1000, 'smoke check complete');
    },
  };
}

function validateSnapshot(result, runId, sequence, gateIds) {
  assert.equal(result.message_type, 'congestion', result.detail ?? 'Expected a congestion response');
  assert.equal(result.run_id, runId);
  assert.equal(result.sequence, sequence);
  assert.deepEqual(result.gates.map((gate) => gate.gate_id).sort(), [...gateIds].sort());
  assert.equal(result.zones.length, 12, 'Expected eight gate zones and four base-path zones');
  assert.equal(result.forecasts.length, 24, 'Expected two forecast horizons for every live zone');
  assert.deepEqual([...new Set(result.forecasts.map((forecast) => forecast.horizon_minutes))]
    .sort((left, right) => left - right), [5, 10]);
  assert.ok(result.forecasts.every((forecast) =>
    ['baseline', 'gbm'].includes(forecast.method) && Number.isFinite(forecast.predicted_density)),
  'Expected finite live baseline or model forecasts');
  assert.ok(Array.isArray(result.routing.assignments), 'Expected real routing assignment deltas');
  assert.deepEqual(Object.keys(result.routing.gate_wait_seconds).sort(), [...gateIds].sort());
}

function agentsForIncident(stadium, queuedGate, queueSize) {
  const angle = queuedGate.angleDeg * Math.PI / 180;
  const approachScale = (stadium.gateDefaults.approachInnerScale +
    stadium.gateDefaults.approachOuterScale) / 2;
  return Array.from({ length: stadium.population }, (_, personId) => {
    const queued = personId < queueSize;
    const seatAngle = (personId % 360) * Math.PI / 180;
    const seatScale = 0.65 + ((personId % 20) / 20) * 0.25;
    return {
      person_id: personId,
      x: stadium.bowl.rx * (queued ? approachScale * Math.cos(angle) : seatScale * Math.cos(seatAngle)),
      z: stadium.bowl.rz * (queued ? approachScale * Math.sin(angle) : seatScale * Math.sin(seatAngle)),
      speed_mps: queued ? 0.1 : 0,
      target_gate: queued ? queuedGate.id : stadium.gates[personId % stadium.gates.length].id,
      movement_state: queued ? 'queued' : 'waiting',
      phase: queued ? 'queue' : 'waiting',
    };
  });
}

async function main() {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22 && typeof WebSocket === 'function',
    'This smoke test requires Node.js 22 or newer (built-in fetch and WebSocket).');
  assert.ok(process.argv.length <= 3, 'Usage: node scripts/docker-smoke.mjs [http://localhost:8080]');
  const base = new URL(process.argv[2] ?? 'http://localhost:8080');
  assert.ok(['http:', 'https:'].includes(base.protocol), 'Base URL must use http:// or https://');
  assert.ok(base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
    'Pass an origin only, without credentials, a path, a query, or a fragment.');
  const stadium = JSON.parse(await readFile(new URL('../shared/stadium-config.json', import.meta.url), 'utf8'));
  const gateIds = stadium.gates.map((gate) => gate.id);
  assert.equal(stadium.population, 4_000);
  assert.equal(gateIds.length, 8);
  console.log(`Checking NorthStar at ${base.origin}`);

  const document = await request(base, '/');
  assert.match(document.headers.get('content-type') ?? '', /text\/html/i);
  const html = await document.text();
  assert.match(html, /id=["']root["']/, 'Frontend HTML must contain the React root');
  const bundle = html.match(/<script\b[^>]*\bsrc=["'](\/assets\/[^"']+\.js)["']/i)?.[1];
  assert.ok(bundle, 'Expected a production JavaScript bundle under /assets/');
  const bundleResponse = await request(base, bundle);
  assert.match(bundleResponse.headers.get('content-type') ?? '', /javascript/i);
  await bundleResponse.arrayBuffer();
  console.log('PASS frontend HTML and production bundle');

  const frontendHealth = await request(base, '/health');
  assert.doesNotMatch(await frontendHealth.text(), /<!doctype|<html/i,
    '/health must be the frontend health endpoint, not the SPA fallback');
  assert.deepEqual(await json(base, '/api/health'), { status: 'ok' });
  const state = await json(base, '/api/state');
  assert.ok(Array.isArray(state.zones) && state.zones.length > 0, 'Expected simulation state with zones');
  assert.ok(Array.isArray(await json(base, '/api/runs')), 'Expected a live-run list');
  console.log('PASS frontend health, proxied Python health, state, and run APIs');

  const telemetry = await connect(base, '/ws/telemetry');
  const legacyState = await telemetry.receive();
  assert.ok(Array.isArray(legacyState.zones) && legacyState.zones.length > 0);
  telemetry.close();
  console.log('PASS /ws/telemetry upgrade and Python state stream');

  const congestion = await connect(base, '/ws/congestion');
  const ready = await congestion.receive();
  assert.equal(ready.message_type, 'ready');
  assert.equal(ready.population, stadium.population);
  assert.equal(ready.config_version, stadium.version, 'Frontend/shared and Python geometry versions differ');
  assert.deepEqual([...ready.gate_ids].sort(), [...gateIds].sort());
  const queuedGate = stadium.gates.find((gate) => gate.id === 'gate_b');
  assert.ok(queuedGate, 'The stadium fixture requires Gate B');
  const queueSize = Math.max(100, ready.thresholds.high_queue);
  assert.ok(queueSize < stadium.population);
  const agents = agentsForIncident(stadium, queuedGate, queueSize);
  const runId = `docker-smoke-${randomUUID()}`;
  const batch = (sequence, seconds, closed = []) => ({
    message_type: 'telemetry',
    run_id: runId,
    sequence,
    simulation_time_seconds: seconds,
    population: stadium.population,
    agents,
    exited_agents: [],
    closed_gates: closed,
  });
  const submit = async (sequence, seconds, closed) => {
    congestion.send(batch(sequence, seconds, closed));
    const result = await congestion.receive();
    validateSnapshot(result, runId, sequence, gateIds);
    return result;
  };

  const initial = await submit(0, 0);
  const initialGate = initial.gates.find((gate) => gate.gate_id === queuedGate.id);
  assert.equal(initialGate.queue_length, queueSize);
  assert.equal(initialGate.congested, false, 'Congestion must honor simulation-time persistence');
  const detectedAt = ready.thresholds.trigger_persistence_seconds + 1;
  const detected = await submit(1, detectedAt);
  assert.equal(detected.gates.find((gate) => gate.gate_id === queuedGate.id).congested, true,
    'Persistent Gate B congestion was not detected');
  assert.deepEqual(detected.routing.assignments, [], 'Congestion must not authorize a routing plan');
  assert.deepEqual(detected.routing.holds, [], 'Unapproved release holds are forbidden');
  console.log('PASS 4,000-person telemetry, eight gates, 12 zones, 24 forecasts, and persistent congestion');

  const closure = await submit(2, detectedAt + 31, [queuedGate.id]);
  assert.equal(closure.routing.gate_wait_seconds[queuedGate.id], null, 'Closed gate must be unavailable');
  assert.ok(closure.routing.assignments.length > 0, 'A closed gate must trigger nearest-open exit escape');
  assert.ok(closure.routing.assignments.every((assignment) => assignment.reason === 'gate_closed' && assignment.to_gate !== queuedGate.id),
    'Only closed-door escape is automatic; no assignment may target the closed gate');
  assert.deepEqual(closure.routing.holds, [], 'Unapproved release holds are forbidden');
  assert.equal(closure.routing.active_plan_id, null);
  assert.equal(closure.zones.find((zone) => zone.gate_id === queuedGate.id).status, 'closed');
  congestion.close();

  assert.ok((await json(base, '/api/runs')).includes(runId), 'Smoke run was not registered');
  const exported = await json(base, `/api/runs/${runId}/export`);
  assert.equal(exported.run_id, runId);
  assert.equal(exported.timeline.length, 3);
  assert.ok(exported.people_redirected > 0);
  console.log('PASS automatic closed-door escape, no unapproved congestion plan, and live-run export');
  console.log(`NorthStar Docker smoke test passed. Isolated in-memory run: ${runId}`);
}

try {
  await main();
} catch (error) {
  console.error(`FAIL ${error.message}`);
  if (error.cause) console.error(`Cause: ${error.cause.message ?? error.cause}`);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.close();
}
