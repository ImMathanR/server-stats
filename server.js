const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = 3009;
const SSE_INTERVAL = 2000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function execPromise(cmd, timeout = 5000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Previous CPU snapshot (for delta-based usage calculation)
// ---------------------------------------------------------------------------

let prevCpuTimes = null;

function getCpuTimesPerCore() {
  const cpus = os.cpus();
  return cpus.map((cpu) => {
    const { user, nice, sys, idle, irq } = cpu.times;
    return { user, nice, sys, idle, irq, total: user + nice + sys + idle + irq };
  });
}

function calcCpuUsage() {
  const current = getCpuTimesPerCore();
  if (!prevCpuTimes) {
    prevCpuTimes = current;
    return { overall: 0, cores: current.map(() => 0) };
  }

  let totalIdleDelta = 0;
  let totalDelta = 0;
  const cores = current.map((cur, i) => {
    const prev = prevCpuTimes[i];
    const idleDelta = cur.idle - prev.idle;
    const totalD = cur.total - prev.total;
    totalIdleDelta += idleDelta;
    totalDelta += totalD;
    return totalD === 0 ? 0 : parseFloat((((totalD - idleDelta) / totalD) * 100).toFixed(1));
  });

  prevCpuTimes = current;
  const overall = totalDelta === 0 ? 0 : parseFloat((((totalDelta - totalIdleDelta) / totalDelta) * 100).toFixed(1));
  return { overall, cores };
}

// ---------------------------------------------------------------------------
// Previous network snapshot (for rate calculation)
// ---------------------------------------------------------------------------

let prevNetBytes = null;
let prevNetTime = null;

async function getNetworkIO() {
  const raw = await execPromise("cat /proc/net/dev 2>/dev/null");
  if (!raw) return { bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0 };

  let bytesIn = 0;
  let bytesOut = 0;
  for (const line of raw.split('\n')) {
    if (line.includes(':')) {
      const iface = line.split(':')[0].trim();
      if (iface === 'lo') continue;
      const parts = line.split(':')[1].trim().split(/\s+/);
      bytesIn += parseInt(parts[0], 10) || 0;
      bytesOut += parseInt(parts[8], 10) || 0;
    }
  }

  const now = Date.now();
  let rateIn = 0;
  let rateOut = 0;
  if (prevNetBytes && prevNetTime) {
    const dt = (now - prevNetTime) / 1000;
    if (dt > 0) {
      rateIn = (bytesIn - prevNetBytes.bytesIn) / dt;
      rateOut = (bytesOut - prevNetBytes.bytesOut) / dt;
    }
  }
  prevNetBytes = { bytesIn, bytesOut };
  prevNetTime = now;

  return {
    bytesIn: formatBytes(bytesIn),
    bytesOut: formatBytes(bytesOut),
    rateIn: formatBytes(Math.max(0, rateIn)) + '/s',
    rateOut: formatBytes(Math.max(0, rateOut)) + '/s',
  };
}

// ---------------------------------------------------------------------------
// Stat collectors
// ---------------------------------------------------------------------------

async function getSystemStats() {
  const cpu = calcCpuUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const loadAvg = os.loadavg();

  const diskRaw = await execPromise("df -B1 / | tail -1");
  let disk = { used: 0, total: 0, percent: 0 };
  if (diskRaw) {
    const parts = diskRaw.split(/\s+/);
    const total = parseInt(parts[1], 10);
    const used = parseInt(parts[2], 10);
    disk = {
      used: formatBytes(used),
      total: formatBytes(total),
      percent: total ? parseFloat(((used / total) * 100).toFixed(1)) : 0,
    };
  }

  const network = await getNetworkIO();
  const kernelRaw = await execPromise("uname -r");

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    kernel: kernelRaw || os.release(),
    uptime: formatUptime(os.uptime()),
    uptimeSeconds: os.uptime(),
    cpu: {
      model: os.cpus()[0]?.model || 'Unknown',
      count: os.cpus().length,
      overall: cpu.overall,
      cores: cpu.cores,
    },
    memory: {
      used: formatBytes(usedMem),
      total: formatBytes(totalMem),
      percent: parseFloat(((usedMem / totalMem) * 100).toFixed(1)),
    },
    disk,
    loadAvg: {
      '1m': loadAvg[0].toFixed(2),
      '5m': loadAvg[1].toFixed(2),
      '15m': loadAvg[2].toFixed(2),
    },
    network,
  };
}

async function getDockerServices() {
  const runningRaw = await execPromise("docker ps --format '{{json .}}' 2>/dev/null");
  const allRaw = await execPromise("docker ps -a --format '{{json .}}' 2>/dev/null");

  function parseLines(raw) {
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  const running = parseLines(runningRaw);
  const all = parseLines(allRaw);
  const runningIds = new Set(running.map((c) => c.ID));

  const services = all.map((c) => ({
    id: c.ID,
    name: c.Names,
    image: c.Image,
    status: c.Status,
    ports: c.Ports || '',
    state: c.State || (runningIds.has(c.ID) ? 'running' : 'exited'),
    running: runningIds.has(c.ID),
    createdAt: c.CreatedAt || '',
  }));

  return services;
}

async function getClaudeSessions() {
  const raw = await execPromise("tmux list-sessions 2>/dev/null");
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    const match = line.match(/^(.+?):\s+(\d+)\s+windows?\s+\(created\s+(.+?)\)\s*(\[.*\])?\s*(.*)/);
    if (!match) {
      const simple = line.match(/^(.+?):\s+(\d+)\s+windows?/);
      if (simple) {
        return {
          name: simple[1],
          windows: parseInt(simple[2], 10),
          created: '',
          attached: line.includes('(attached)'),
        };
      }
      return { name: line.split(':')[0], windows: 0, created: '', attached: false };
    }
    return {
      name: match[1],
      windows: parseInt(match[2], 10),
      created: match[3],
      attached: line.includes('(attached)'),
    };
  });
}

async function getTopProcesses() {
  const byCpuRaw = await execPromise("ps aux --sort=-%cpu | head -6");
  const byMemRaw = await execPromise("ps aux --sort=-%mem | head -6");

  function parsePs(raw) {
    if (!raw) return [];
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length < 2) return [];
    return lines.slice(1).map((line) => {
      const parts = line.split(/\s+/);
      return {
        user: parts[0],
        pid: parts[1],
        cpu: parts[2],
        mem: parts[3],
        vsz: parts[4],
        rss: parts[5],
        command: parts.slice(10).join(' ').substring(0, 80),
      };
    });
  }

  return {
    byCpu: parsePs(byCpuRaw),
    byMem: parsePs(byMemRaw),
  };
}

async function collectAllStats() {
  const [system, docker, sessions, processes] = await Promise.all([
    getSystemStats(),
    getDockerServices(),
    getClaudeSessions(),
    getTopProcesses(),
  ]);
  return { system, docker, sessions, processes, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const sseClients = new Set();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // SSE endpoint
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial data immediately
    try {
      const data = await collectAllStats();
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      // ignore
    }

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Static file serving
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', filePath);

  // Security: prevent path traversal
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// Broadcast stats to all SSE clients
async function broadcast() {
  if (sseClients.size === 0) return;
  try {
    const data = await collectAllStats();
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  } catch (e) {
    console.error('Broadcast error:', e.message);
  }
}

setInterval(broadcast, SSE_INTERVAL);

// Prime the CPU snapshot so the first real reading is a delta
calcCpuUsage();

server.listen(PORT, () => {
  console.log(`Server Stats dashboard running on http://localhost:${PORT}`);
});
