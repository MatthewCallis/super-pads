const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** Flush directory entries where the host filesystem supports it. */
function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows and some removable filesystems do not expose directory fsync.
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)
      && !(process.platform === 'win32' && ['EPERM', 'EISDIR', 'EACCES'].includes(error.code))) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Write and flush a new file. Never opens an existing file for truncation. */
function writeNew(file, data) {
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Replace one file only after a complete sibling temporary file has been flushed. */
function atomicWrite(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeNew(temporary, data);
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { atomicWrite, writeNew, syncDirectory };
