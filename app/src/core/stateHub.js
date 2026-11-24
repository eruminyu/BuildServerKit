class StateHub {
  constructor() {
    this.windows = new Set();
    this.sseClients = new Set();

    this.state = {
      build: {
        status: 'idle', // idle | running | success | failed
        mode: '',
        branch: '',
        ref: '',
        author: '',
        message: '',
        projectName: '',
        startedAt: null,
        duration: '00분 00초',
        lastExitCode: null,
        currentLogPath: '',
        currentArchiveDir: '',
      },
      runner: {
        installed: false,
        configured: false,
        running: false,
        apiPolling: false,
      },
      mirror: {
        running: false,
        autoEnabled: false,
        schedulerRegistered: false,
        lastCL: 0,
        lastRunAt: null,
        lastStatus: 'idle',
        lastMessage: '대기 중',
      },
      webServer: {
        running: false,
        port: 3780,
        url: '',
        readOnly: true,
      },
      workflow: {
        hasWorkflow: false,
        workflowType: 'none', // none | git | perforce
        summary: '저장소 연결 후 확인 가능',
      },
    };

    this.consoleLines = [];
    this.errorLines = [];
    this.maxConsole = 2500;
    this.maxErrors = 400;
  }

  attachWindow(win) {
    this.windows.add(win);
    win.on('closed', () => this.windows.delete(win));
  }

  attachSseClient(res) {
    this.sseClients.add(res);
    res.on('close', () => this.sseClients.delete(res));
  }

  broadcast(channel, payload) {
    for (const win of this.windows) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send(channel, payload);
        } catch {}
      }
    }
    if (this.sseClients.size > 0) {
      const frame = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const res of this.sseClients) {
        try {
          res.write(frame);
        } catch {
          this.sseClients.delete(res);
        }
      }
    }
  }

  updateSection(section, partial) {
    this.state[section] = { ...this.state[section], ...partial };
    this.broadcast('state:update', { section, data: this.state[section] });
  }

  getSnapshot() {
    return {
      state: this.state,
      consoleLines: this.consoleLines,
      errorLines: this.errorLines,
    };
  }

  appendLog(text, level = 'info') {
    const entry = {
      ts: new Date().toTimeString().slice(0, 8),
      text: String(text),
      level,
    };
    this.consoleLines.push(entry);
    if (this.consoleLines.length > this.maxConsole) {
      this.consoleLines.splice(0, this.consoleLines.length - this.maxConsole);
    }
    this.broadcast('console:line', entry);

    if (level === 'error' || this._isErrorLine(entry.text)) {
      this.errorLines.push(entry);
      if (this.errorLines.length > this.maxErrors) {
        this.errorLines.splice(0, this.errorLines.length - this.maxErrors);
      }
      this.broadcast('console:error', entry);
    }
  }

  clearConsole() {
    this.consoleLines = [];
    this.errorLines = [];
    this.broadcast('console:clear', {});
  }

  _isErrorLine(line) {
    return /(error C\d+:|\bfatal error\b|\bError:|Ensure condition failed|Unable to find plugin|Result: Failed|UnrealBuildTool failed|AutomationTool exiting with ExitCode)/i.test(
      line
    );
  }
}

module.exports = { StateHub };
