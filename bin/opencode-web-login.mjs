#!/usr/bin/env node
import { runCLI } from '../cli.mjs';
try { await runCLI(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
