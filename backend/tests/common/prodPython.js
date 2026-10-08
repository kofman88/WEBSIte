'use strict';
/**
 * prodPython.js — the interpreter the production bot runs: CPython 3.11 (deploy.sh virtualenv
 * …/virtualenv/CHM_BREAKER_V4/3.11, Dockerfile python:3.11-slim). Python-generated strategy fixtures
 * record `sys.version.split()[0]`; 3.12 differs in builtin sum() over floats (Neumaier-compensated)
 * and unicodedata, so a fixture made with another interpreter is not the bot's truth.
 */
const PROD_PYTHON = /^3\.11\.\d+$/;

module.exports = { PROD_PYTHON };
