'use strict';
// Tiny JSON file store. One file, written atomically (write temp file, then rename),
// so a crash or power cut can never leave a half-written database.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = this._read();
    this._timer = null;
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Keep the broken file for inspection instead of silently overwriting it.
        const bad = this.file + '.broken-' + Date.now();
        try { fs.renameSync(this.file, bad); } catch (_) {}
        console.error('[store] could not read database, moved it to', bad, e.message);
      }
      return {};
    }
  }

  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  // Coalesce many writes in the same tick into one disk write.
  save() {
    if (this._timer) return;
    this._timer = setImmediate(() => {
      this._timer = null;
      this.flush();
    });
  }

  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
