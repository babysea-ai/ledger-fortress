#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_PLATFORM = 'other';
const DEFAULT_URL = 'https://sentry.io';
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const prefix = '[sentry-project-check]';
const RESERVED_PROJECT_SLUGS = new Set(['babysea']);
const sensitiveValues = new Set();

function rememberSensitive(value) {
  if (typeof value === 'string' && value.length > 1) {
    sensitiveValues.add(value);
  }
}

function readLocalConfig() {
  let contents = '';

  try {
    contents = readFileSync('.sentryclirc', 'utf8');
  } catch {
    return {};
  }

  const config = {};
  let section = '';

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);

    if (sectionMatch) {
      section = sectionMatch[1];
      config[section] ??= {};
      continue;
    }

    const separatorIndex = line.indexOf('=');

    if (separatorIndex === -1 || !section) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    config[section][key] = value;
  }

  return config.defaults ?? {};
}

function getConfig() {
  const defaults = readLocalConfig();
  const org = process.env.SENTRY_ORG || defaults.org;
  const project = process.env.SENTRY_PROJECT || defaults.project;
  const token = process.env.SENTRY_AUTH_TOKEN;
  const url = (process.env.SENTRY_URL || defaults.url || DEFAULT_URL).replace(
    /\/+$/,
    '',
  );
  const expectedPlatform =
    process.env.SENTRY_EXPECTED_PLATFORM || DEFAULT_PLATFORM;
  const strictOwnership = process.env.SENTRY_STRICT_OWNERSHIP !== '0';

  for (const value of [org, project, token, url]) {
    rememberSensitive(value);
  }

  if (!org) {
    throw new Error(
      'SENTRY_ORG is required as a repository secret or ignored local config.',
    );
  }

  if (!project) {
    throw new Error(
      'SENTRY_PROJECT is required as a repository secret or ignored local config.',
    );
  }

  if (RESERVED_PROJECT_SLUGS.has(project.toLowerCase())) {
    throw new Error('Refusing to check the reserved main Sentry project.');
  }

  if (!token) {
    throw new Error(
      'SENTRY_AUTH_TOKEN is required as a repository secret; do not commit it.',
    );
  }

  return {
    expectedPlatform,
    org,
    project,
    strictOwnership,
    token,
    url,
  };
}

function redact(value) {
  let redacted = String(value);

  for (const sensitiveValue of sensitiveValues) {
    redacted = redacted.split(sensitiveValue).join('[redacted-sentry-config]');
  }

  return redacted
    .replace(/sntry[a-z0-9_]+/gi, '[redacted-sentry-token]')
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer [redacted]')
    .slice(0, 700);
}

async function sentryApi(config, path, options = {}) {
  const optionalStatuses = new Set(options.optionalStatuses ?? []);
  const requestUrl = `${config.url}/api/0${path}`;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(requestUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      method: options.method ?? 'GET',
    });

    const text = await response.text();

    if (!response.ok && RETRY_STATUS.has(response.status) && attempt < 3) {
      await sleep(250 * attempt);
      continue;
    }

    if (!response.ok) {
      if (optionalStatuses.has(response.status)) {
        console.warn(
          `${prefix} optional Sentry endpoint skipped; returned ${response.status}.`,
        );
        return undefined;
      }

      throw new Error(`Sentry API ${response.status}: ${redact(text)}`);
    }

    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Sentry API returned invalid JSON: ${error.message}`);
    }
  }

  throw new Error('Sentry API retry budget exhausted.');
}

async function main() {
  const config = getConfig();
  const projectPath = `/projects/${encodeURIComponent(
    config.org,
  )}/${encodeURIComponent(config.project)}/`;
  const failures = [];

  console.log(`${prefix} checking configured Sentry project`);

  const project = await sentryApi(config, projectPath);

  if (project.slug !== config.project) {
    failures.push('configured project did not match the Sentry API response');
  }

  if (project.organization?.slug && project.organization.slug !== config.org) {
    failures.push(
      'configured organization did not match the Sentry API response',
    );
  }

  if (project.status && String(project.status).toLowerCase() !== 'active') {
    failures.push('configured project is not active');
  }

  if (
    config.expectedPlatform &&
    project.platform &&
    project.platform !== config.expectedPlatform
  ) {
    failures.push('configured platform did not match the Sentry API response');
  }

  const ownership = await sentryApi(config, `${projectPath}ownership/`, {
    optionalStatuses: config.strictOwnership ? [] : [403, 404],
  });

  if (ownership) {
    const rawOwnership = typeof ownership.raw === 'string' ? ownership.raw : '';

    if (!rawOwnership.trim()) {
      failures.push('Sentry ownership rules are empty.');
    }
  }

  if (failures.length > 0) {
    throw new Error(`Sentry project check failed:\n- ${failures.join('\n- ')}`);
  }

  console.log(`${prefix} OK: configured Sentry project is active and guarded.`);
  console.log(
    `${prefix} Seer stays dashboard-managed; this repo ships no Sentry runtime SDK or DSN.`,
  );
}

main().catch((error) => {
  console.error(`${prefix} ${redact(error.message)}`);
  process.exit(1);
});
