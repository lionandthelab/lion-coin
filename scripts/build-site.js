#!/usr/bin/env node
'use strict';

// state.json + logs/*.md → _site/index.html (GitHub Pages 배포 산출물)

const fs = require('node:fs');
const path = require('node:path');
const { buildSiteModel, renderPage } = require('../harness/lib/site');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, '_site');

const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'harness', 'state.json'), 'utf8'));

const logsDir = path.join(ROOT, 'logs');
const logFiles = !fs.existsSync(logsDir)
  ? []
  : fs
      .readdirSync(logsDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => ({ name, content: fs.readFileSync(path.join(logsDir, name), 'utf8') }));

const html = renderPage(buildSiteModel(state, logFiles), new Date().toISOString());

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
fs.writeFileSync(path.join(OUT_DIR, '.nojekyll'), '');
console.log(`빌드 완료: _site/index.html (로그 ${logFiles.length}개 포함)`);
