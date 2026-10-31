'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Manages streaming writes to disk with backpressure handling,
 * clean pause/flush semantics, and atomic completion renaming.
 */
class DownloadWriter {
  /**
   * @param {object} opts
   * @param {string} opts.destinationPath destination directory
   * @param {string} opts.filename final filename
   * @param {string} [opts.partialPath] explicit partial path; defaults to `${destinationPath}/${filename}.barq-part`
   */
  constructor({ destinationPath, filename, partialPath = null }) {
    this.destinationPath = path.resolve(destinationPath);
    this.filename = filename;
    this.partialPath = partialPath ? path.resolve(partialPath) : path.join(this.destinationPath, `${this.filename}.barq-part`);
    this.finalPath = path.join(this.destinationPath, this.filename);

    this.fileStream = null;
    this.bytesWritten = 0;
    this.isOpen = false;
    this.isClosing = false;
  }

  /**
   * Returns current size of partial file on disk in bytes.
   * @returns {number}
   */
  getExistingBytes() {
    try {
      if (fs.existsSync(this.partialPath)) {
        return fs.statSync(this.partialPath).size;
      }
    } catch {}
    return 0;
  }

  /**
   * Opens the file stream for writing.
   * @param {boolean} [append=false] true if resuming and appending to partial file
   */
  open(append = false) {
    if (this.isOpen) return;

    // Ensure directory exists
    fs.mkdirSync(this.destinationPath, { recursive: true });

    const flags = append ? 'a' : 'w';
    this.fileStream = fs.createWriteStream(this.partialPath, { flags, highWaterMark: 64 * 1024 });
    this.isOpen = true;
    this.isClosing = false;
    this.bytesWritten = append ? this.getExistingBytes() : 0;
  }

  /**
   * Pipes an incoming readable stream through the writer with backpressure control.
   *
   * @param {import('node:stream').Readable} readable
   * @param {object} callbacks
   * @param {(chunkBytes: number, totalWritten: number) => void} callbacks.onProgress
   * @param {(err: Error) => void} callbacks.onError
   * @param {() => void} callbacks.onEnd
   */
  pipe(readable, { onProgress, onError, onEnd }) {
    if (!this.isOpen || !this.fileStream) {
      throw new Error('DownloadWriter must be opened before piping data.');
    }

    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      readable.removeListener('data', onData);
      readable.removeListener('error', handleError);
      readable.removeListener('end', handleEnd);
      readable.removeListener('close', handleClose);
    };

    const onData = (chunk) => {
      if (finished || this.isClosing) return;

      const ok = this.fileStream.write(chunk);
      this.bytesWritten += chunk.length;

      if (onProgress) {
        onProgress(chunk.length, this.bytesWritten);
      }

      if (!ok) {
        // Backpressure: pause readable until fileStream drains
        readable.pause();
        this.fileStream.once('drain', () => {
          if (!finished && !this.isClosing) {
            readable.resume();
          }
        });
      }
    };

    const handleError = (err) => {
      cleanup();
      if (onError) onError(err);
    };

    const handleEnd = () => {
      cleanup();
      if (onEnd) onEnd();
    };

    const handleClose = () => {
      cleanup();
      if (onEnd) onEnd();
    };

    readable.on('data', onData);
    readable.on('error', handleError);
    readable.on('end', handleEnd);
    readable.on('close', handleClose);
  }

  /**
   * Flushes and closes the stream cleanly.
   * @returns {Promise<number>} final bytes written on disk
   */
  close() {
    if (!this.isOpen || !this.fileStream) {
      return Promise.resolve(this.getExistingBytes());
    }

    this.isClosing = true;

    return new Promise((resolve, reject) => {
      this.fileStream.end(() => {
        this.isOpen = false;
        this.isClosing = false;

        // Sync to disk
        try {
          const fd = fs.openSync(this.partialPath, 'r');
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        } catch {}

        this.bytesWritten = this.getExistingBytes();
        resolve(this.bytesWritten);
      });

      this.fileStream.once('error', (err) => {
        this.isOpen = false;
        this.isClosing = false;
        reject(err);
      });
    });
  }

  /**
   * Finalizes download by closing partial stream and atomically renaming
   * `<filename>.barq-part` to `<filename>`.
   * @returns {Promise<string>} final resolved file path
   */
  async finalize() {
    await this.close();

    if (!fs.existsSync(this.partialPath)) {
      throw new Error(`Partial file disappeared before finalization: ${this.partialPath}`);
    }

    // Atomically rename
    try {
      if (fs.existsSync(this.finalPath)) {
        fs.rmSync(this.finalPath, { force: true });
      }
      fs.renameSync(this.partialPath, this.finalPath);
    } catch (err) {
      // Cross-device fallback if needed
      fs.copyFileSync(this.partialPath, this.finalPath);
      fs.rmSync(this.partialPath, { force: true });
    }

    return this.finalPath;
  }

  /**
   * Discards the partial file from disk.
   */
  async discard() {
    try {
      await this.close();
    } catch {}

    try {
      if (fs.existsSync(this.partialPath)) {
        fs.rmSync(this.partialPath, { force: true });
      }
    } catch {}
  }
}

module.exports = { DownloadWriter };
