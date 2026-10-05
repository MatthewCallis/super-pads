const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite, syncDirectory } = require('./fileStorage');

const TRANSACTION = '.super-pads-transaction';
const SAMPLE_DIRECTORY = 'ROLAND/SP-404SX/SMPL';

/** Only application-owned card files may appear in a recovery journal. Paths use portable slashes. */
function validTarget(target) {
  return target === 'super-pads.json' || target === `${SAMPLE_DIRECTORY}/PAD_INFO.BIN`
    || /^ROLAND\/SP-404SX\/SMPL\/[A-J]00000(?:0[1-9]|1[0-2])\.WAV$/.test(target)
    || /^ROLAND\/SP-404SX\/PTN\/PTN00(?:0\d\d|1[01]\d)\.BIN$/.test(target);
}

/** Copy and flush a backup without consuming it; recovery must be repeatable after another failure. */
function copyDurable(source, destination) {
  fs.copyFileSync(source, destination);
  const fd = fs.openSync(destination, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Recover an interrupted commit before reading or writing the card.
 * A durable COMMITTED marker selects cleanup; otherwise the journal restores every previous file.
 * On recovery failure, backups remain in place and the caller must prevent further editing.
 */
function recoverCard(root) {
  const directory = path.join(root, TRANSACTION);
  const completed = path.join(root, `${TRANSACTION}-complete`);
  // Remove completed transactions outside the recovery namespace: cleanup may itself be interrupted.
  fs.rmSync(completed, { recursive: true, force: true });
  if (!fs.existsSync(directory)) return;
  const journalFile = path.join(directory, 'journal.json');
  if (fs.existsSync(journalFile) && !fs.existsSync(path.join(directory, 'COMMITTED'))) {
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    if (journal.version !== 1 || !Array.isArray(journal.entries)
      || journal.entries.some((entry) => !validTarget(entry.target) || typeof entry.existed !== 'boolean')
      || new Set(journal.entries.map((entry) => entry.target)).size !== journal.entries.length) {
      throw new Error('Invalid card recovery journal. Keep the recovery folder for repair.');
    }
    // Copies preserve all backups until every restoration has succeeded, even across repeated crashes.
    for (const [index, entry] of journal.entries.entries()) {
      const target = path.join(root, entry.target);
      if (entry.existed) {
        const temporary = path.join(directory, 'restore.tmp');
        copyDurable(path.join(directory, `backup-${index}`), temporary);
        fs.renameSync(temporary, target);
      } else {
        fs.rmSync(target, { force: true });
      }
      syncDirectory(path.dirname(target));
    }
    // Recovery is now complete. Mark it before deleting backups so interrupted cleanup is safe.
    atomicWrite(path.join(directory, 'COMMITTED'), 'recovered\n');
  }
  fs.renameSync(directory, completed);
  syncDirectory(root);
  fs.rmSync(completed, { recursive: true });
  syncDirectory(root);
}

/**
 * Own one card save. Staging never changes final files; commit keeps backups until its marker is durable.
 * The caller must serialize card access and invoke rollback after any staging/commit exception.
 */
class CardTransaction {
  constructor(root) {
    this.root = root;
    this.directory = path.join(root, TRANSACTION);
    /** Ordered replacements/deletions; staged paths stay private until the recovery journal is durable. */
    this.entries = [];
    // An existing directory belongs to recovery or another operation; never overwrite it here.
    fs.mkdirSync(this.directory);
    syncDirectory(root);
  }

  /** Reserve a staged replacement path, or a deletion when remove is true. */
  stage(target, remove = false) {
    if (!validTarget(target) || this.entries.some((entry) => entry.target === target)) {
      throw new Error(`Invalid or duplicate card destination: ${target}`);
    }
    const staged = path.join(this.directory, `new-${this.entries.length}`);
    this.entries.push({ target, remove, staged });
    return staged;
  }

  /** Commit all replacements/deletions. Returns a warning only when post-commit cleanup fails. */
  commit() {
    const entries = this.entries.map((entry, index) => {
      const target = path.join(this.root, entry.target);
      const existed = fs.existsSync(target);
      if (existed) copyDurable(target, path.join(this.directory, `backup-${index}`));
      return { target: entry.target, existed };
    });
    // No final file is touched until the backups and their journal have been flushed.
    atomicWrite(path.join(this.directory, 'journal.json'), JSON.stringify({ version: 1, entries }));
    for (const entry of this.entries) {
      const target = path.join(this.root, entry.target);
      if (entry.remove) fs.rmSync(target, { force: true });
      else fs.renameSync(entry.staged, target);
      syncDirectory(path.dirname(target));
    }
    try {
      atomicWrite(path.join(this.directory, 'COMMITTED'), 'committed\n');
    } catch (error) {
      // A failed marker flush must leave this transaction eligible for rollback.
      fs.rmSync(path.join(this.directory, 'COMMITTED'), { force: true });
      throw error;
    }
    try {
      recoverCard(this.root);
    } catch (error) {
      // The save is already committed. Reporting failure here would invite a duplicate retry.
      return `Saved successfully; recovery-folder cleanup will retry when reopened: ${error.message}`;
    }
    return undefined;
  }

  /** Restore previous card contents, or discard staging when commit never started. */
  rollback() { recoverCard(this.root); }
}

module.exports = { CardTransaction, recoverCard, SAMPLE_DIRECTORY };
