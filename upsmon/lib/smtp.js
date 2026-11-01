'use strict';
// 极简 SMTP 客户端 —— 不引入第三方依赖
// 支持：25/587 明文+STARTTLS、465 隐式 TLS、AUTH PLAIN / AUTH LOGIN
const net = require('net');
const tls = require('tls');

class SmtpSession {
  constructor(sock) {
    this.sock = sock;
    this.buf = '';
    this.waiter = null;
    this.closed = false;
    this.error = null;
    sock.setEncoding('utf8');
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => { this.error = e; this._flushReject(e); });
    sock.on('close', () => { this.closed = true; this._flushReject(new Error('SMTP 连接被关闭')); });
  }

  _onData(chunk) {
    this.buf += chunk;
    this._tryResolve();
  }

  _tryResolve() {
    if (!this.waiter) return;
    // SMTP 多行响应：以 "250-" 开头表示续行，最后一行是 "250 "
    const m = this.buf.match(/^(?:\d{3}-[^\n]*\n)*\d{3} [^\n]*\n/);
    if (!m) return;
    const resp = m[0];
    this.buf = this.buf.slice(resp.length);
    const w = this.waiter;
    this.waiter = null;
    const code = parseInt(resp.slice(0, 3), 10);
    w.resolve({ code, text: resp.trim() });
  }

  _flushReject(err) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }

  read() {
    return new Promise((resolve, reject) => {
      if (this.error) return reject(this.error);
      if (this.closed) return reject(new Error('SMTP 连接已关闭'));
      this.waiter = { resolve, reject };
      this._tryResolve();
    });
  }

  async cmd(line, expect) {
    if (line !== null) this.sock.write(line + '\r\n');
    const r = await this.read();
    if (expect && r.code !== expect) {
      const e = new Error('SMTP ' + (line || '') + ' 返回 ' + r.code + '：' + r.text);
      e.code = r.code;
      throw e;
    }
    return r;
  }
}

function connect(host, port, secure) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: host };
    const sock = secure ? tls.connect(opts, () => resolve(sock)) : net.connect(opts, () => resolve(sock));
    sock.once('error', reject);
    sock.setTimeout(20000, () => { sock.destroy(); reject(new Error('SMTP 连接超时')); });
  });
}

function upgradeToTls(sock, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: sock, servername: host }, () => resolve(secure));
    secure.once('error', reject);
  });
}

async function sendMail(opts) {
  const {
    host, port = 465, secure = true, user = '', pass = '',
    from, to = [], subject = '', text = '', timeout = 20000
  } = opts;

  if (!host) throw new Error('SMTP 服务器地址为空');
  const recipients = (Array.isArray(to) ? to : String(to).split(/[,;]/)).map(s => s.trim()).filter(Boolean);
  if (!recipients.length) throw new Error('收件人为空');
  if (!from) throw new Error('发件人为空');

  let sock = await connect(host, port, secure);
  let s = new SmtpSession(sock);

  await s.cmd(null, 220);
  const ehloDomain = 'ups-monitor.local';
  let r = await s.cmd('EHLO ' + ehloDomain, 250);

  if (!secure) {
    const supportsStartTLS = /STARTTLS/i.test(r.text);
    if (supportsStartTLS) {
      await s.cmd('STARTTLS', 220);
      const secureSock = await upgradeToTls(sock, host);
      s = new SmtpSession(secureSock);
      r = await s.cmd('EHLO ' + ehloDomain, 250);
    }
  }

  if (user) {
    const plain = Buffer.from('\0' + user + '\0' + pass, 'utf8').toString('base64');
    try {
      await s.cmd('AUTH PLAIN ' + plain, 235);
    } catch (e) {
      // 退回 LOGIN 方式
      await s.cmd('AUTH LOGIN', 334);
      await s.cmd(Buffer.from(user, 'utf8').toString('base64'), 334);
      await s.cmd(Buffer.from(pass, 'utf8').toString('base64'), 235);
    }
  }

  await s.cmd('MAIL FROM:<' + from + '>', 250);
  for (const rcpt of recipients) {
    await s.cmd('RCPT TO:<' + rcpt + '>', 250);
  }
  await s.cmd('DATA', 354);

  const body = String(text).replace(/\r?\n/g, '\r\n');
  const stuffed = body.split('\r\n').map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
  const payload = 'From: ' + from + '\r\n' +
    'To: ' + recipients.join(', ') + '\r\n' +
    'Subject: ' + subject + '\r\n' +
    'Date: ' + new Date().toUTCString() + '\r\n' +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: text/plain; charset=UTF-8\r\n\r\n' +
    stuffed + '\r\n.';
  sock.write(payload);
  await s.cmd(null, 250);

  try { await s.cmd('QUIT', 221); } catch (_) { /* 忽略退出异常 */ }
  try { sock.destroy(); } catch (_) {}
  return { ok: true, to: recipients };
}

module.exports = { sendMail };
