#!/usr/bin/env node
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

const CONFIG = {
  httpPort: 18080,
  socksPort: 18081,
  connectTimeoutMs: 15000,
  logFile: path.join(process.env.HOME, '.claude', 'residential-proxy', 'proxy.log'),
  upstreams: {
    residential: {
      host: 'RESIDENTIAL_HOST',
      port: 1080,
      username: 'RESIDENTIAL_USERNAME',
      password: 'RESIDENTIAL_PASSWORD',
    },
    clash: {
      host: '127.0.0.1',
      port: 7897,
      username: '',
      password: '',
    },
  },
  residentialHosts: [
    // Claude / Anthropic
    'anthropic.com',
    'claude.ai',
    'claude.com',
    'modelcontextprotocol.io',
    'anthropic.statuspage.io',
    'statsig.anthropic.com',
    // Gemini / Google AI
    'gemini.google.com',
    'aistudio.google.com',
    'generativelanguage.googleapis.com',
    'ai.google.dev',
    'daily-cloudcode-pa.googleapis.com',
    'www.googleapis.com',
    'oauth2.googleapis.com',
    'lh3.googleusercontent.com',
    'yunwu.ai',
    // GPT / OpenAI
    'openai.com',
    'chatgpt.com',
    'oaistatic.com',
    'oaiusercontent.com',
    // Verification
    'ifconfig.me',
  ],
  residentialHostKeywords: [
    'antigravity',
    'anti-gravity',
  ],
};

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(CONFIG.logFile, line);
  } catch (_error) {
    // Keep the proxy running even if the log file is unavailable.
  }
}

function isResidentialHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  if (CONFIG.residentialHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return true;
  }
  return CONFIG.residentialHostKeywords.some((keyword) => host.includes(keyword));
}

function routeForHost(hostname) {
  return isResidentialHost(hostname) ? 'residential' : 'clash';
}

function parseHostPort(authority, defaultPort) {
  const value = String(authority || '').trim();
  if (!value) return null;

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    const port = rest.startsWith(':') ? Number.parseInt(rest.slice(1), 10) : defaultPort;
    return { host, port: Number.isFinite(port) ? port : defaultPort };
  }

  const lastColon = value.lastIndexOf(':');
  if (lastColon > -1 && value.indexOf(':') === lastColon) {
    const host = value.slice(0, lastColon);
    const port = Number.parseInt(value.slice(lastColon + 1), 10);
    return { host, port: Number.isFinite(port) ? port : defaultPort };
  }

  return { host: value, port: defaultPort };
}

function encodeSocksAddress(host) {
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4.test(host)) {
    return {
      atyp: 0x01,
      data: Buffer.from(host.split('.').map((part) => Number.parseInt(part, 10))),
    };
  }

  const hostBuffer = Buffer.from(host, 'utf8');
  if (hostBuffer.length > 255) {
    throw new Error(`Host is too long for SOCKS5 domain mode: ${host}`);
  }

  return {
    atyp: 0x03,
    data: Buffer.concat([Buffer.from([hostBuffer.length]), hostBuffer]),
  };
}

function waitForReadable(socket) {
  return new Promise((resolve, reject) => {
    const onReadable = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Socket closed while waiting for data'));
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error('Timed out while waiting for data'));
    };
    function cleanup() {
      socket.off('readable', onReadable);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
    }
    socket.on('readable', onReadable);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('timeout', onTimeout);
  });
}

async function readExact(socket, size) {
  const chunks = [];
  let total = 0;

  while (total < size) {
    let chunk = socket.read(size - total);
    if (!chunk) {
      await waitForReadable(socket);
      chunk = socket.read(size - total);
    }
    if (!chunk) {
      continue;
    }
    chunks.push(chunk);
    total += chunk.length;
  }

  return Buffer.concat(chunks, total);
}

function writeBuffer(socket, buffer) {
  return new Promise((resolve, reject) => {
    socket.write(buffer, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function connectViaSocks(upstream, targetHost, targetPort) {
  const socket = net.createConnection({ host: upstream.host, port: upstream.port });
  socket.setTimeout(CONFIG.connectTimeoutMs);
  socket.setNoDelay(true);

  await new Promise((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error(`Timed out connecting to upstream ${upstream.host}:${upstream.port}`));
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Upstream ${upstream.host}:${upstream.port} closed during connect`));
    };
    function cleanup() {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
      socket.off('close', onClose);
    }
    socket.on('connect', onConnect);
    socket.on('error', onError);
    socket.on('timeout', onTimeout);
    socket.on('close', onClose);
  });

  const needsAuth = Boolean(upstream.username);
  await writeBuffer(socket, Buffer.from([0x05, 0x01, needsAuth ? 0x02 : 0x00]));
  const greeting = await readExact(socket, 2);
  if (greeting[0] !== 0x05 || greeting[1] === 0xff) {
    socket.destroy();
    throw new Error(`SOCKS5 greeting failed for upstream ${upstream.host}:${upstream.port}`);
  }

  if (greeting[1] === 0x02) {
    const user = Buffer.from(upstream.username, 'utf8');
    const pass = Buffer.from(upstream.password, 'utf8');
    const auth = Buffer.concat([
      Buffer.from([0x01, user.length]),
      user,
      Buffer.from([pass.length]),
      pass,
    ]);
    await writeBuffer(socket, auth);
    const authReply = await readExact(socket, 2);
    if (authReply[1] !== 0x00) {
      socket.destroy();
      throw new Error(`SOCKS5 auth failed for upstream ${upstream.host}:${upstream.port}`);
    }
  }

  const addr = encodeSocksAddress(targetHost);
  const request = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, addr.atyp]),
    addr.data,
    Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
  ]);
  await writeBuffer(socket, request);

  const head = await readExact(socket, 4);
  if (head[1] !== 0x00) {
    socket.destroy();
    throw new Error(`SOCKS5 CONNECT failed for ${targetHost}:${targetPort} via ${upstream.host}:${upstream.port}`);
  }

  let toRead = 0;
  if (head[3] === 0x01) toRead = 4 + 2;
  else if (head[3] === 0x04) toRead = 16 + 2;
  else if (head[3] === 0x03) {
    const len = await readExact(socket, 1);
    toRead = len[0] + 2;
  } else {
    socket.destroy();
    throw new Error(`Unsupported SOCKS5 reply type: ${head[3]}`);
  }
  await readExact(socket, toRead);
  socket.setTimeout(0);
  return socket;
}

function routeUpstream(host) {
  const route = routeForHost(host);
  return { route, upstream: CONFIG.upstreams[route] };
}

function tunnel(client, remote) {
  client.pipe(remote);
  remote.pipe(client);
  client.on('error', () => remote.destroy());
  remote.on('error', () => client.destroy());
}

function closeWithHttpError(socket, status, message) {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`);
}

function startHttpProxy() {
  const server = net.createServer((client) => {
    client.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let handled = false;

    const onData = async (chunk) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf('\r\n\r\n');
      if (marker === -1) return;
      handled = true;
      client.off('data', onData);

      const headerBytes = buffer.slice(0, marker + 4);
      const bodyBytes = buffer.slice(marker + 4);
      const headerText = headerBytes.toString('latin1');
      const lines = headerText.split('\r\n').filter(Boolean);
      if (!lines.length) {
        closeWithHttpError(client, '400 Bad Request', 'Missing request line');
        return;
      }

      const [method, rawTarget, version] = lines[0].split(' ');
      const headers = [];
      const headerMap = new Map();
      for (const line of lines.slice(1)) {
        const index = line.indexOf(':');
        if (index === -1) continue;
        const name = line.slice(0, index);
        const value = line.slice(index + 1).trim();
        headerMap.set(name.toLowerCase(), value);
        if (!['proxy-connection', 'proxy-authorization'].includes(name.toLowerCase())) {
          headers.push([name, value]);
        }
      }

      try {
        if (method === 'CONNECT') {
          const target = parseHostPort(rawTarget, 443);
          if (!target) throw new Error(`Invalid CONNECT target: ${rawTarget}`);
          const { route, upstream } = routeUpstream(target.host);
          log(`HTTP CONNECT ${target.host}:${target.port} via ${route}`);
          const remote = await connectViaSocks(upstream, target.host, target.port);
          client.write('HTTP/1.1 200 Connection established\r\n\r\n');
          if (bodyBytes.length) remote.write(bodyBytes);
          tunnel(client, remote);
          return;
        }

        let url;
        try {
          url = new URL(rawTarget);
        } catch (_error) {
          const host = headerMap.get('host');
          url = new URL(`http://${host}${rawTarget}`);
        }

        const targetHost = url.hostname;
        const targetPort = Number.parseInt(url.port || '80', 10);
        const { route, upstream } = routeUpstream(targetHost);
        log(`HTTP ${method} ${targetHost}:${targetPort} via ${route}`);
        const remote = await connectViaSocks(upstream, targetHost, targetPort);

        const requestPath = `${url.pathname || '/'}${url.search || ''}`;
        const requestHead = [
          `${method} ${requestPath} ${version || 'HTTP/1.1'}`,
          ...headers.map(([name, value]) => `${name}: ${value}`),
          '',
          '',
        ].join('\r\n');
        remote.write(requestHead, 'latin1');
        if (bodyBytes.length) remote.write(bodyBytes);
        tunnel(client, remote);
      } catch (error) {
        log(`HTTP proxy error: ${error.message}`);
        closeWithHttpError(client, '502 Bad Gateway', error.message);
      }
    };

    client.on('data', onData);
    client.on('error', () => {});
  });

  server.listen(CONFIG.httpPort, '127.0.0.1', () => {
    log(`HTTP proxy listening on 127.0.0.1:${CONFIG.httpPort}`);
  });
  return server;
}

function parseSocksTarget(buffer, offset) {
  const atyp = buffer[offset];
  if (atyp === 0x01) {
    if (buffer.length < offset + 7) return null;
    const host = Array.from(buffer.slice(offset + 1, offset + 5)).join('.');
    const port = buffer.readUInt16BE(offset + 5);
    return { host, port, size: 7 };
  }
  if (atyp === 0x03) {
    if (buffer.length < offset + 2) return null;
    const len = buffer[offset + 1];
    if (buffer.length < offset + 2 + len + 2) return null;
    const host = buffer.slice(offset + 2, offset + 2 + len).toString('utf8');
    const port = buffer.readUInt16BE(offset + 2 + len);
    return { host, port, size: 2 + len + 2 };
  }
  if (atyp === 0x04) {
    if (buffer.length < offset + 19) return null;
    const host = buffer.slice(offset + 1, offset + 17).toString('hex');
    const port = buffer.readUInt16BE(offset + 17);
    return { host, port, size: 19 };
  }
  throw new Error(`Unsupported SOCKS5 target type: ${atyp}`);
}

function startSocksProxy() {
  const server = net.createServer((client) => {
    client.setNoDelay(true);
    let state = 'greeting';
    let buffer = Buffer.alloc(0);

    const tryHandle = async () => {
      try {
        if (state === 'greeting') {
          if (buffer.length < 2) return;
          const methods = buffer[1];
          if (buffer.length < 2 + methods) return;
          buffer = buffer.slice(2 + methods);
          client.write(Buffer.from([0x05, 0x00]));
          state = 'request';
        }

        if (state === 'request') {
          if (buffer.length < 4) return;
          if (buffer[0] !== 0x05 || buffer[1] !== 0x01) {
            client.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const target = parseSocksTarget(buffer, 3);
          if (!target) return;
          buffer = buffer.slice(3 + target.size);

          const { route, upstream } = routeUpstream(target.host);
          log(`SOCKS CONNECT ${target.host}:${target.port} via ${route}`);
          const remote = await connectViaSocks(upstream, target.host, target.port);
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (buffer.length) remote.write(buffer);
          buffer = Buffer.alloc(0);
          state = 'proxy';
          tunnel(client, remote);
        }
      } catch (error) {
        log(`SOCKS proxy error: ${error.message}`);
        try {
          client.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        } catch (_error) {
          client.destroy();
        }
      }
    };

    client.on('data', (chunk) => {
      if (state === 'proxy') return;
      buffer = Buffer.concat([buffer, chunk]);
      void tryHandle();
    });
    client.on('error', () => {});
  });

  server.listen(CONFIG.socksPort, '127.0.0.1', () => {
    log(`SOCKS proxy listening on 127.0.0.1:${CONFIG.socksPort}`);
  });
  return server;
}

startHttpProxy();
startSocksProxy();
