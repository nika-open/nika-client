#!/usr/bin/env node
/**
 * SDK Coverage Checker
 *
 * The live contract is the pinned OpenAPI at repo-root openapi.json
 * (W09.B). SDK helpers must call every live runtime path and must not call
 * absent ones. The OpenAPI document itself is a generation surface.
 *
 * A live operation the package does not wrap yet is listed by name in
 * NOT_WRAPPED, with the engine release that added it. Each entry must be
 * an operation of the pinned contract, and a path listed there must not be
 * called by the SDK: wrapping one means removing its entry here.
 *
 * Exit 0 = covered. Exit 1 = drift.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SDK_ROOT = resolve(import.meta.dirname, '..');
const SPEC = join(SDK_ROOT, 'openapi.json');
const SDK_FILES = [
  join(SDK_ROOT, 'src/lib/http-transport.ts'),
];

const ABSENT = [
  '/v1/run',
  '/v1/status',
  '/v1/cancel',
  '/v1/events',
  '/v1/reload',
  '/v1/schedules/:param/backfill',
];

// Live operations of the pinned contract that this package version does not
// wrap. Engine 0.125.0 added them; the 0.125.0 package is a lockstep release
// on that engine, and the methods that call them are a later change.
const NOT_WRAPPED = [
  ['get', '/v1/jobs', 'engine 0.125.0, capability jobList'],
  ['get', '/v1/jobs/{id}/attempts', 'engine 0.125.0, capability jobRetry'],
  ['post', '/v1/jobs/{id}/retry', 'engine 0.125.0, capability jobRetry'],
  ['get', '/v1/occupancy', 'engine 0.125.0, capability occupancy'],
  ['get', '/v1/schedules', 'engine 0.125.0, capability scheduleManage'],
  ['delete', '/v1/schedules/{id}', 'engine 0.125.0, capability scheduleManage'],
  ['post', '/v1/schedules/{id}/trigger', 'engine 0.125.0, capability scheduleManage'],
];

function livePaths() {
  const spec = JSON.parse(readFileSync(SPEC, 'utf-8'));
  return Object.keys(spec.paths || {});
}

function extractSdkEndpoints() {
  const endpoints = [];
  for (const file of SDK_FILES) {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf-8');
    const apiCallRegex = /([`'"])((?:\/health|\/v1\/).*?)\1/gs;
    let match;
    while ((match = apiCallRegex.exec(src)) !== null) {
      const cleaned = match[2].replace(/\$\{[^}]+\}/g, ':param');
      if (cleaned.startsWith('/')) endpoints.push(cleaned.split('?')[0]);
    }
  }
  return [...new Set(endpoints)];
}

function normalize(path) {
  return path
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/:param/g, ':param');
}

if (!existsSync(SPEC)) {
  console.error(`missing pin: ${SPEC}`);
  process.exit(1);
}

const live = livePaths().map(normalize);
const sdk = extractSdkEndpoints();
const sdkNorm = sdk.map(normalize);
const contract = JSON.parse(readFileSync(SPEC, 'utf-8'));

let failed = false;

console.log('Machine schema bindings:');
for (const [label, actual, expected] of [
  ['health JSON', contract.paths?.['/health']?.get?.responses?.['200']?.content?.['application/json']?.schema?.$ref, '#/components/schemas/Health'],
  ['workflow list JSON', contract.paths?.['/v1/workflows']?.get?.responses?.['200']?.content?.['application/json']?.schema?.$ref, '#/components/schemas/WorkflowList'],
  ['workflow metadata JSON', contract.paths?.['/v1/workflows/{name}']?.get?.responses?.['200']?.content?.['application/json']?.schema?.$ref, '#/components/schemas/WorkflowMetadata'],
  ['SSE event extension', contract.paths?.['/v1/jobs/{id}/events']?.get?.responses?.['200']?.content?.['text/event-stream']?.['x-nika-event-schema']?.$ref, '#/components/schemas/JobEvent'],
  ['receipt origin schema', contract.components?.schemas?.JobReceipt?.properties?.origin?.$ref, '#/components/schemas/JobOrigin'],
]) {
  if (actual !== expected) {
    console.log(`  MISSING  ${label}: expected ${expected}`);
    failed = true;
  } else {
    console.log(`  ok       ${label}`);
  }
}
const eventSchema = contract.components?.schemas?.JobEvent;
if (eventSchema?.additionalProperties !== false) {
  console.log('  MISSING  JobEvent must close additionalProperties');
  failed = true;
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const operationsOf = (item) => Object.keys(item || {}).filter((key) => HTTP_METHODS.has(key));
const deferred = new Set(NOT_WRAPPED.map(([method, path]) => `${method} ${path}`));

console.log('\nLive operations this package does not wrap yet:');
for (const [method, path, origin] of NOT_WRAPPED) {
  if (!contract.paths?.[path]?.[method]) {
    console.log(`  STALE    ${method.toUpperCase()} ${path}: not an operation of the pinned contract`);
    failed = true;
  } else {
    console.log(`  deferred ${method.toUpperCase()} ${path} (${origin})`);
  }
}
// A path whose every live operation is deferred is one the SDK must not call.
const whollyDeferred = new Set(
  Object.entries(contract.paths || {})
    .filter(([path, item]) => {
      const operations = operationsOf(item);
      return operations.length > 0
        && operations.every((method) => deferred.has(`${method} ${path}`));
    })
    .map(([path]) => normalize(path)),
);

console.log('\nLive OpenAPI paths:');
for (const path of live) {
  const hit = sdkNorm.includes(path)
    || (path === '/v1/workflows/:param'
      && sdkNorm.some((candidate) => candidate.startsWith('/v1/workflows/:param')));
  if (whollyDeferred.has(path)) {
    if (hit) {
      console.log(`  WRAPPED  ${path}: the SDK calls it; remove its NOT_WRAPPED entries`);
      failed = true;
    } else {
      console.log(`  deferred ${path} (not wrapped by this package version)`);
    }
    continue;
  }
  if (!hit) {
    // openapi.json is fetched by generate-types, not the runtime client
    if (path === '/v1/openapi.json') {
      console.log(`  skip runtime  ${path} (pin/generate only)`);
      continue;
    }
    console.log(`  MISSING  ${path}`);
    failed = true;
  } else {
    console.log(`  ok       ${path}`);
  }
}

console.log('\nSDK endpoints must belong to the live contract:');
for (const path of sdkNorm) {
  if (!live.includes(path)) {
    console.log(`  UNKNOWN  ${path}`);
    failed = true;
  } else {
    console.log(`  live     ${path}`);
  }
}

console.log('\nSDK must not claim absent routes:');
for (const path of ABSENT) {
  const claimed = sdkNorm.some((s) => s === path || s.startsWith(`${path}/`));
  if (live.includes(path)) {
    console.log(`  LIVE     ${path}: the pinned contract serves it; remove it from ABSENT`);
    failed = true;
  } else if (claimed) {
    console.log(`  CLAIMED  ${path}`);
    failed = true;
  } else {
    console.log(`  absent   ${path}`);
  }
}

console.log('\nSDK endpoints:', sdkNorm.join(', ') || '(none)');

if (failed) {
  console.error('\ncoverage DRIFT');
  process.exit(1);
}
console.log('\ncoverage OK');
