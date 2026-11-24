const { spawn } = require('child_process');
const iconv = require('iconv-lite');

function isValidUtf8(buf) {
  let i = 0;
  const len = buf.length;
  while (i < len) {
    const b = buf[i];
    if (b <= 0x7f) {
      i += 1;
    } else if ((b & 0xe0) === 0xc0) {
      if (i + 1 >= len || (buf[i + 1] & 0xc0) !== 0x80 || b < 0xc2) return false;
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      if (i + 2 >= len || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80) return false;
      if (b === 0xe0 && buf[i + 1] < 0xa0) return false;
      i += 3;
    } else if ((b & 0xf8) === 0xf0) {
      if (
        i + 3 >= len ||
        (buf[i + 1] & 0xc0) !== 0x80 ||
        (buf[i + 2] & 0xc0) !== 0x80 ||
        (buf[i + 3] & 0xc0) !== 0x80
      ) {
        return false;
      }
      if (b === 0xf0 && buf[i + 1] < 0x90) return false;
      if (b > 0xf4 || (b === 0xf4 && buf[i + 1] > 0x8f)) return false;
      i += 4;
    } else {
      return false;
    }
  }
  return true;
}

function decodeSmart(buf) {
  if (!buf || buf.length === 0) return '';
  let slice = buf;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    slice = buf.subarray(3);
    return slice.toString('utf8');
  }
  if (isValidUtf8(slice)) {
    return slice.toString('utf8');
  }
  return iconv.decode(slice, 'cp949');
}

function splitBufferLines(chunk, carryBuf, onLine) {
  const combined = carryBuf && carryBuf.length > 0 ? Buffer.concat([carryBuf, chunk]) : chunk;
  let start = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] === 0x0a) {
      let end = i;
      if (end > start && combined[end - 1] === 0x0d) end -= 1;
      onLine(decodeSmart(combined.subarray(start, end)));
      start = i + 1;
    }
  }
  return start < combined.length ? Buffer.from(combined.subarray(start)) : Buffer.alloc(0);
}

function spawnStreamed(command, args, options = {}, onLine = () => {}) {
  const proc = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, P4CHARSET: 'utf8', ...(options.env || {}) },
    windowsHide: true,
    shell: Boolean(options.shell),
  });

  let outCarry = Buffer.alloc(0);
  let errCarry = Buffer.alloc(0);

  if (proc.stdout) {
    proc.stdout.on('data', (chunk) => {
      outCarry = splitBufferLines(chunk, outCarry, (line) => onLine(line, 'stdout'));
    });
  }
  if (proc.stderr) {
    proc.stderr.on('data', (chunk) => {
      errCarry = splitBufferLines(chunk, errCarry, (line) => onLine(line, 'stderr'));
    });
  }

  const promise = new Promise((resolve) => {
    proc.on('error', (err) => {
      onLine(`[Process Error] ${err.message}`, 'stderr');
      resolve(-1);
    });
    proc.on('close', (code) => {
      if (outCarry.length > 0) onLine(decodeSmart(outCarry), 'stdout');
      if (errCarry.length > 0) onLine(decodeSmart(errCarry), 'stderr');
      resolve(typeof code === 'number' ? code : -1);
    });
  });

  return { proc, promise };
}

function execCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const outChunks = [];
    const errChunks = [];
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, P4CHARSET: 'utf8', ...(options.env || {}) },
      windowsHide: true,
      shell: Boolean(options.shell),
    });

    let timer = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        killProcessTree(proc.pid);
      }, options.timeoutMs);
    }

    if (proc.stdout) proc.stdout.on('data', (c) => outChunks.push(c));
    if (proc.stderr) proc.stderr.on('data', (c) => errChunks.push(c));

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: err.message });
    });

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: typeof code === 'number' ? code : -1,
        stdout: decodeSmart(Buffer.concat(outChunks)),
        stderr: decodeSmart(Buffer.concat(errChunks)),
      });
    });
  });
}

function execWithStdin(command, args, stdinText = '', options = {}) {
  return new Promise((resolve) => {
    const outChunks = [];
    const errChunks = [];
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, P4CHARSET: 'utf8', ...(options.env || {}) },
      windowsHide: true,
      shell: Boolean(options.shell),
    });

    let timer = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        killProcessTree(proc.pid);
      }, options.timeoutMs);
    }

    if (proc.stdout) proc.stdout.on('data', (c) => outChunks.push(c));
    if (proc.stderr) proc.stderr.on('data', (c) => errChunks.push(c));

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: err.message });
    });

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: typeof code === 'number' ? code : -1,
        stdout: decodeSmart(Buffer.concat(outChunks)),
        stderr: decodeSmart(Buffer.concat(errChunks)),
      });
    });

    if (proc.stdin) {
      proc.stdin.end(Buffer.from(String(stdinText || ''), 'utf8'));
    }
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
  } catch {}
}

module.exports = {
  decodeSmart,
  spawnStreamed,
  execCapture,
  execWithStdin,
  killProcessTree,
};
