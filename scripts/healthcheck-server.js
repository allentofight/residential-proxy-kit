#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 18100;
const PROXY_HTTP = 'http://127.0.0.1:18080';
const LOG_FILE = path.join(process.env.HOME || '', '.claude', 'residential-proxy', 'proxy.log');
const HTML_FILE = path.join(process.env.HOME || '', '.claude', 'residential-proxy', 'healthcheck.html');
const DEFAULT_EXPECTED_IP = (process.env.EXPECTED_RESIDENTIAL_IP || '').trim();

const TARGETS = [
  'claude.ai',
  'chatgpt.com',
  'gemini.google.com',
  'daily-cloudcode-pa.googleapis.com',
];

function execFileAsync(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 2,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
        });
      }
    );
  });
}

function pushCheck(list, name, passed, detail, required = true) {
  list.push({
    name,
    passed: Boolean(passed),
    detail: detail || '',
    required,
  });
}

function parseProxyPorts(scutilOutput) {
  const readPort = (key) => {
    const match = scutilOutput.match(new RegExp(`${key}\\s*:\\s*(\\d+)`));
    return match ? Number.parseInt(match[1], 10) : null;
  };

  return {
    httpPort: readPort('HTTPPort'),
    httpsPort: readPort('HTTPSPort'),
    socksPort: readPort('SOCKSPort'),
  };
}

async function runChecks(expectedIp) {
  const checks = [];

  const scutil = await execFileAsync('scutil', ['--proxy']);
  if (!scutil.ok) {
    pushCheck(checks, '系统代理端口', false, scutil.stderr || '无法读取 scutil --proxy 输出');
  } else {
    const ports = parseProxyPorts(scutil.stdout);
    const ok = ports.httpPort === 18080 && ports.httpsPort === 18080 && ports.socksPort === 18081;
    pushCheck(
      checks,
      '系统代理端口',
      ok,
      `HTTP:${ports.httpPort ?? '-'} HTTPS:${ports.httpsPort ?? '-'} SOCKS:${ports.socksPort ?? '-'}`
    );
  }

  const lsof18080 = await execFileAsync('lsof', ['-nP', '-iTCP:18080', '-sTCP:LISTEN'], 10000);
  pushCheck(
    checks,
    '本地代理监听 18080',
    lsof18080.ok && lsof18080.stdout.includes('LISTEN'),
    lsof18080.ok ? '已监听' : (lsof18080.stderr || '未监听')
  );

  const lsof18081 = await execFileAsync('lsof', ['-nP', '-iTCP:18081', '-sTCP:LISTEN'], 10000);
  pushCheck(
    checks,
    '本地代理监听 18081',
    lsof18081.ok && lsof18081.stdout.includes('LISTEN'),
    lsof18081.ok ? '已监听' : (lsof18081.stderr || '未监听')
  );

  const residential = await execFileAsync(
    'curl',
    ['-sS', '--max-time', '20', '-x', PROXY_HTTP, 'http://ifconfig.me/ip'],
    25000
  );
  const residentialIp = residential.ok ? residential.stdout : '';
  if (expectedIp) {
    pushCheck(
      checks,
      '家宽出口 IP',
      residential.ok && residentialIp === expectedIp,
      residential.ok ? `当前: ${residentialIp}` : (residential.stderr || '获取失败')
    );
  } else {
    pushCheck(
      checks,
      '家宽出口 IP',
      residential.ok && residentialIp.length > 0,
      residential.ok ? `当前: ${residentialIp}（未设置预期 IP，仅检查可用性）` : (residential.stderr || '获取失败'),
      false
    );
  }

  const normal = await execFileAsync(
    'curl',
    ['-sS', '--max-time', '20', '-x', PROXY_HTTP, 'https://api.ipify.org'],
    25000
  );
  const normalIp = normal.ok ? normal.stdout : '';
  pushCheck(
    checks,
    '普通线路出口 IP',
    normal.ok && normalIp.length > 0,
    normal.ok ? `当前: ${normalIp}${normalIp === expectedIp ? '（与家宽相同，请确认是否符合预期）' : ''}` : (normal.stderr || '获取失败'),
    false
  );

  const probeFailures = [];
  for (const host of TARGETS) {
    const probe = await execFileAsync(
      'curl',
      ['-sS', '-I', '--max-time', '25', '-x', PROXY_HTTP, `https://${host}`],
      30000
    );
    if (!probe.ok) probeFailures.push(host);
  }
  pushCheck(
    checks,
    '目标域名连通性探测',
    probeFailures.length === 0,
    probeFailures.length === 0 ? '全部可探测' : `失败: ${probeFailures.join(', ')}`,
    false
  );

  let recentLog = '';
  if (fs.existsSync(LOG_FILE)) {
    try {
      const full = fs.readFileSync(LOG_FILE, 'utf8');
      recentLog = full.split('\n').slice(-800).join('\n');
    } catch (_error) {
      recentLog = '';
    }
  }

  const missingRoutes = [];
  for (const host of TARGETS) {
    if (!recentLog.includes(host) || !recentLog.includes(`${host}:443 via residential`)) {
      // fallback: accept HTTP GET/HEAD on port 80 too
      if (!recentLog.includes(`${host}:80 via residential`) && !recentLog.includes(`${host} via residential`)) {
        missingRoutes.push(host);
      }
    }
  }

  pushCheck(
    checks,
    '关键域名路由命中（日志）',
    missingRoutes.length === 0,
    missingRoutes.length === 0 ? '全部命中 residential' : `缺失: ${missingRoutes.join(', ')}`
  );

  const requiredFailed = checks.some((item) => item.required && !item.passed);

  return {
    ok: !requiredFailed,
    expectedIp,
    checkedAt: new Date().toISOString(),
    checks,
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  try {
    const base = `http://${HOST}:${PORT}`;
    const urlObj = new URL(req.url || '/', base);

    if (req.method === 'GET' && urlObj.pathname === '/api/check') {
      const expectedIp = (urlObj.searchParams.get('expectedIp') || DEFAULT_EXPECTED_IP).trim();
      const result = await runChecks(expectedIp);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && (urlObj.pathname === '/' || urlObj.pathname === '/healthcheck.html')) {
      if (!fs.existsSync(HTML_FILE)) {
        sendHtml(res, 500, '<h1>healthcheck.html not found</h1>');
        return;
      }
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      sendHtml(res, 200, html);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { error: String(error && error.message ? error.message : error) });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`[healthcheck] UI running at http://${HOST}:${PORT}\n`);
});
