'use strict';
// 极简 HTTP/1.0 客户端
// 存在的理由：Vertiv ITA2 内建 Web 服务基于 lwIP 1.3.1，只懂 HTTP/1.0，
// 对 HTTP/1.1 的 keep-alive / chunked 会直接 RST 连接（Node fetch、PowerShell
// Invoke-WebRequest 都会因此失败）。这里手写请求行 + Connection: close，
// 每个请求一个短连接，兼容性最好，也没有第三方依赖。
const net = require('net');

function parseResponse(buf) {
  const idx = buf.indexOf('\r\n\r\n');
  if (idx < 0) {
    return { status: 0, headers: {}, body: buf.toString('utf8') };
  }
  const headText = buf.slice(0, idx).toString('latin1');
  const bodyBuf = buf.slice(idx + 4);
  const lines = headText.split('\r\n');
  const statusLine = lines.shift() || '';
  const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
  const headers = {};
  for (const line of lines) {
    const p = line.indexOf(':');
    if (p < 0) continue;
    const k = line.slice(0, p).trim().toLowerCase();
    const v = line.slice(p + 1).trim();
    headers[k] = headers[k] ? headers[k] + '; ' + v : v;
  }
  return { status: m ? parseInt(m[1], 10) : 0, headers, body: bodyBuf.toString('utf8') };
}

function request(opts) {
  const {
    host, port = 80, method = 'GET', path = '/',
    headers = {}, body = null, timeout = 8000
  } = opts;

  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const chunks = [];
    let done = false;
    const t0 = Date.now();

    const finish = (err) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      if (err) return reject(err);
      const buf = Buffer.concat(chunks);
      const r = parseResponse(buf);
      r.ms = Date.now() - t0;
      r.bytes = buf.length;
      resolve(r);
    };

    sock.setTimeout(timeout, () => finish(new Error('timeout ' + timeout + 'ms')));
    sock.on('error', (e) => finish(e));

    sock.on('connect', () => {
      let head = method + ' ' + path + ' HTTP/1.0\r\n';
      head += 'Host: ' + host + ':' + port + '\r\n';
      head += 'Connection: close\r\n';
      head += 'User-Agent: UPSMonitor/1.0\r\n';
      head += 'Accept: */*\r\n';
      for (const k of Object.keys(headers)) {
        head += k + ': ' + headers[k] + '\r\n';
      }
      let payload = null;
      if (body != null) {
        payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
        head += 'Content-Length: ' + payload.length + '\r\n';
      }
      head += '\r\n';
      sock.write(head);
      if (payload) sock.write(payload);
    });

    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => finish(null));
    sock.on('close', () => finish(null));
  });
}

module.exports = { request, parseResponse };
