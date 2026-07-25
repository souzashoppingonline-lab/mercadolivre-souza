#!/usr/bin/env node
/**
 * Print Agent — roda no PC da expedição. Puxa etiquetas da VPS e imprime na
 * impressora térmica (ex.: Elgin PRO FULL) em silêncio, via SumatraPDF.
 *
 * Sem dependências npm — só Node nativo. Configuração em config.json (ver
 * config.example.json). Documentação completa: README.md e .claude/print-agent.md.
 *
 * Fluxo (loop de polling):
 *   GET  {baseUrl}/print-agent/jobs/next        (reivindica 1 job)
 *   GET  {baseUrl}/print-agent/jobs/:id/pdf     (baixa o PDF 10x15)
 *   SumatraPDF -print-to "<printer>" -print-settings noscale arquivo.pdf
 *   POST {baseUrl}/print-agent/jobs/:id/confirm (ou /error)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { URL } = require('url');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const BASE = cfg.baseUrl.replace(/\/$/, '');
const TOKEN = cfg.stationToken;
const PRINTER = cfg.printerName;                     // ex.: "Elgin PRO FULL"
const SUMATRA = cfg.sumatraPath || 'SumatraPDF.exe'; // caminho do SumatraPDF
const POLL_MS = Number(cfg.pollIntervalMs) || 3000;
const TMP = path.join(os.tmpdir(), 'print-agent');
fs.mkdirSync(TMP, { recursive: true });

function req(method, urlStr, { headers = {}, asBuffer = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(u, { method, headers: { 'x-station-token': TOKEN, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.toString().slice(0, 200)}`));
        resolve(asBuffer ? body : (body.length ? JSON.parse(body.toString()) : {}));
      });
    });
    r.on('error', reject);
    r.end();
  });
}

// Imprime um PDF em silêncio. -print-settings noscale é ESSENCIAL: sem isso o
// Windows encolhe a etiqueta ("fit to page") e sai fora de escala na 10x15.
function printPdf(file) {
  return new Promise((resolve, reject) => {
    execFile(SUMATRA, ['-print-to', PRINTER, '-print-settings', 'noscale', '-silent', file],
      { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

async function handleOne() {
  const { job } = await req('GET', `${BASE}/print-agent/jobs/next`);
  if (!job) return false; // nada na fila
  const file = path.join(TMP, `job-${job.id}.pdf`);
  try {
    const pdf = await req('GET', `${BASE}/print-agent/jobs/${job.id}/pdf`, { asBuffer: true });
    fs.writeFileSync(file, pdf);
    await printPdf(file);
    await req('POST', `${BASE}/print-agent/jobs/${job.id}/confirm`);
    console.log(`[print-agent] ✅ impresso job ${job.id} (${job.shipping_id || ''})`);
  } catch (e) {
    console.error(`[print-agent] ✗ job ${job.id}: ${e.message}`);
    try {
      await req('POST', `${BASE}/print-agent/jobs/${job.id}/error`,
        { headers: { 'content-type': 'application/json' } });
    } catch {}
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
  return true;
}

async function loop() {
  try {
    // esvazia a fila (imprime todos os pendentes) antes de dormir
    while (await handleOne()) { /* continua enquanto houver job */ }
  } catch (e) {
    console.error('[print-agent] erro no ciclo:', e.message); // VPS fora do ar etc — tenta de novo no próximo tick
  }
  setTimeout(loop, POLL_MS);
}

console.log(`[print-agent] iniciado — estação em ${BASE}, impressora "${PRINTER}", poll ${POLL_MS}ms`);
loop();
