/**
 * config.engineWorker — ENGINE_WORKER=1 starts the engine worker with the server (server.js
 * startBackground, never under tests); default on in production, off in every other env.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const CFG = req.resolve('../../../config/index.js');

const SECRETS = {
  JWT_SECRET: 'test-jwt-secret-0123456789abcdef012',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abc',
  WALLET_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  CORS_ORIGIN: 'https://example.test',
};

function loadWith(env) {
  const saved = { ...process.env };
  const cached = req.cache[CFG];
  try {
    for (const k of ['ENGINE_WORKER', 'NODE_ENV']) delete process.env[k];
    Object.assign(process.env, SECRETS, env);
    delete req.cache[CFG];
    return req(CFG).engineWorker;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    delete req.cache[CFG];
    if (cached) req.cache[CFG] = cached;
  }
}

describe('config.engineWorker (ENGINE_WORKER)', () => {
  it('default: on in production, off in development / test', () => {
    expect(loadWith({ NODE_ENV: 'production' })).toBe(true);
    expect(loadWith({ NODE_ENV: 'development' })).toBe(false);
    expect(loadWith({ NODE_ENV: 'test' })).toBe(false);
  });

  it('explicit flag wins: ENGINE_WORKER=0 turns it off in production, =1 on elsewhere', () => {
    expect(loadWith({ NODE_ENV: 'production', ENGINE_WORKER: '0' })).toBe(false);
    expect(loadWith({ NODE_ENV: 'development', ENGINE_WORKER: '1' })).toBe(true);
    expect(loadWith({ NODE_ENV: 'development', ENGINE_WORKER: ' 1 ' })).toBe(true);
    expect(loadWith({ NODE_ENV: 'development', ENGINE_WORKER: 'yes' })).toBe(false);
  });
});
