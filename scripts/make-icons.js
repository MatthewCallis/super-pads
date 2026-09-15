const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

// Resolve through the declared electron-builder dependency instead of relying on a globally installed CLI.
const builderRequire = createRequire(require.resolve('electron-builder'));
const { runIconsTool } = builderRequire('app-builder-lib/out/toolsets/icons');

/** Generate all icon formats before updating build resources; optional output path supports isolated checks. */
async function main() {
  const project = path.join(__dirname, '..');
  const output = path.resolve(process.argv[2] || path.join(project, 'build-resources', 'icons'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'super-pads-icons-'));
  try {
    for (const format of ['icns', 'ico', 'set']) {
      const outDir = path.join(temporary, format);
      await fs.mkdir(outDir);
      await runIconsTool({ inputFile: path.join(project, 'Art', 'icon.png'), outputFormat: format, outDir });
    }
    await fs.mkdir(path.join(output, 'png'), { recursive: true });
    await fs.copyFile(path.join(temporary, 'icns', 'icon.icns'), path.join(output, 'icon.icns'));
    await fs.copyFile(path.join(temporary, 'ico', 'icon.ico'), path.join(output, 'icon.ico'));
    for (const file of await fs.readdir(path.join(temporary, 'set'))) {
      if (/^\d+x\d+\.png$/.test(file)) {
        await fs.copyFile(path.join(temporary, 'set', file), path.join(output, 'png', file));
      }
    }
    console.log(`Generated macOS, Windows, and Linux icons in ${output}`);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
