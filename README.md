# Super Pads / スーパーパッド

Super Pads helps manage samples on a SP-404SX.

![Super Pads](https://raw.githubusercontent.com/MatthewCallis/super-pads/master/example.png)

Check the [releases page](https://github.com/MatthewCallis/super-pads/releases) for the latest version.

## Latest Version: v1.3.0 (2026-09-14)

- Pad Editor now shows all ten pad banks together in a wider and resizable window.
- Pattern Import / Export! You can now import and export your patterns to and from MIDI
- Fixed several bugs and edge cases.

## How to Use

1. Open the app
1. Select your SD Card root directory by clicking `Pick Folder`
1. Click any pad in banks A–J to edit its settings on the left.
1. Adjust parameters, remove samples, or drop an audio file directly onto any pad. You can also use `Drop File or Pick File` on the left. Imported files are converted to Wave with [FFmpeg](https://ffmpeg.org/) when saving.
1. Drag a sample to another pad to move it. Dropping onto an occupied pad swaps both samples, including their settings and trim points. Pending imports can be moved too.
1. Click `Write SD Card` to save your changes and convert imported files. Imports, transfers, and removals stay queued until you write the card.
1. If any error comes up you will see it above the pad matrix, click it to dismiss.
1. If you think something should be working but it not, please [file an issue](https://github.com/MatthewCallis/super-pads/issues) or [tweet at me](https://twitter.com/superfamicom/status/1343989480160522240).

Card writes stage imports and transfers before changing the card and keep recovery backups until the save completes. Failed conversions retain your pending edits for a retry. If a save is interrupted, reopen the card in Super Pads to recover it before using it in the sampler. Leave the `.super-pads-transaction` recovery folder in place until recovery completes. Staging and backups require free space for the changed samples and their previous versions.

### Video Tutorials

Some super kind folks have made videos showing how to use Super Pads:

- [Super Pads: a New Program for Loading Sounds Onto Your SP-404SX](https://www.youtube.com/watch?v=DIjpT0F07uU)
- [Short Super Pads Tutorial by lilblizzard97](https://www.tiktok.com/@lilblizzard97/video/6933257457384819973) / [Mirror](https://streamable.com/k0yun0)

## Tempo Mode

`Tempo Mode` is another name for the `Time Modify` / `Time Adjust` settings when adjusting the BPM, where turning the knob all the way to the left is Off `oFF`, so the sample will play at its original length.

Turning the knob all the way to the right is Pattern `Ptn` and will set the sample to play at the tempo of the pattern. The BPM can be between `40` and `200`, and `User` will use the custom value.

The BPM can only be adjusted to any value from 0.5 to ~1.3 times the original BPM on the machine.

See page 30 of the manual.

## macOS Tips

To disable and remove the dot files from your SD Cards and free up some space, run these commands in your Terminal of choice where `<FS NAME>` is your SD Card, by default on the name of card that came with the SP-404SX is `SP-404SX`, so you would access it like `/Volumes/SP-404SX/`:

```sh
# Prevent the OS from using DS files on USB drives
sudo defaults write com.apple.desktopservices DSDontWriteUSBStores -bool true

# Disable Spotlifht from index this drive
sudo mdutil -i off /Volumes/<FS NAME>

# Remove existing cruft
cd /Volumes/<FS NAME>
sudo rm -rf .{DS_Store,fseventsd,Spotlight-V*,Trashes}

# If this has been used on a Windows OS, you can remove the `System Volume Information` as well
sudo rm -rf System\ Volume\ Information/
```

## Building from Source

Use Node.js 24 or newer (Node.js 24 LTS is selected by `.nvmrc`). Electron 44 requires macOS 13 Ventura or newer and Windows 10 or newer. See [Electron's breaking changes](https://www.electronjs.org/docs/latest/breaking-changes) for platform support details.

Install the locked dependencies and run the build for your platform. On macOS this produces a separate `.dmg` for each architecture:

```sh
# If you use nvm:
nvm install
nvm use

npm ci
npm start

# Validate audio workers and the Electron UI
npm test
npm run test:smoke

# Compile styles once, or watch with npm run scss
npm run scss-build

# macOS - builds both Apple Silicon (arm64) and Intel (x64) dmgs
npm run build
#  -> dist/Super Pads-mac-arm64.dmg   (Apple Silicon)
#  -> dist/Super Pads-mac-x64.dmg     (Intel)

# Build a single macOS architecture
npm run package-mac-arm   # Apple Silicon only
npm run package-mac-x64   # Intel only

# Other platforms
npm run package-win
npm run package-linux
```

The bundled FFmpeg ([`ffmpeg-static-electron`](https://www.npmjs.com/package/ffmpeg-static-electron)) ships native binaries for both `arm64` and `x64`, and the correct one is selected automatically at runtime, so each build runs natively with no Rosetta. Electron downloads its development binary on the first `npm start` or `npm run test:smoke`; those first runs require network access.

The audio libraries and FFmpeg binary package remain at their latest published versions. `fluent-ffmpeg` is updated to its final release, 2.1.3, but is deprecated upstream; replacing that wrapper is a separate migration.

### Build all GitHub release assets

Run this on macOS to build all five release files into `dist/`:

```sh
npm run package
```

- `Super Pads-mac-arm64.dmg` - Apple Silicon
- `Super Pads-mac-x64.dmg` - Intel macOS
- `Super Pads-win.exe` - Windows x64 portable app
- `Super Pads-linux.tar.bz2` - Linux x64 archive
- `Super Pads-linux.AppImage` - Linux x64 AppImage

Upload these files to a GitHub release. The command uses `--publish never` to keep uploading a separate step. Windows and Linux targets explicitly use x64 because the bundled FFmpeg package has no ARM64 binaries for those platforms; macOS builds both architectures.

Cross-platform packaging downloads additional build tools on the first run. See electron-builder's [multi-platform build requirements](https://www.electron.build/v26/docs/features/multi-platform-build/) for host prerequisites.

### macOS build notes

- Code signing is skipped automatically when no Developer ID certificate is available; set up signing/notarization for distribution.
- The `.dmg` packaging step shells out to `python3` (provided by recent electron-builder). Building on Apple Silicon with an Intel (Rosetta) Node can make that step pick the wrong architecture for `xcrun`; building with a native `arm64` Node avoids it.
- Keep application file rules in the shared `build.files` list. Separate platform lists containing only exclusions can add a second catch-all matcher in electron-builder, inadvertently bundling other workspaces and old build outputs.

## Notes

Super Pads makes use of two libraries I wrote to play with my own SP-404SX, [uttori-audio-padinfo](https://github.com/uttori/uttori-audio-padinfo) for parsing and writing the `PAD_INFO.BIN` file and [uttori-audio-wave](https://github.com/uttori/uttori-audio-wave) for adding the `RLND` header to the Wave files out of FFmpeg, and an Electron wrapper to make it easier to use.

_Note:_ I do not have an OG SP-404 or SP-404A but this could easily support those if someone is willing to help debug issues.

If you would like to suggest something or have found an issue please file a bug or message me on Twitter [@superfamicom](https://twitter.com/superfamicom).

If you would like to support development, listen to my songs, follow me, or playlist my songs 😏

- [Spotify](https://open.spotify.com/artist/0FYTwSXr4Q7Ujml4wW7Y97)
- [SoundCloud](https://soundcloud.com/superfamicom)
- [Bandcamp](https://matthewcallis.bandcamp.com/)
- [Audius](https://audius.co/superfamicom)

## Roadmap

Features I have planned to work on as time permits, roughly in order:

- Investigate alternatives to Electron like [Tauri](https://github.com/tauri-apps/tauri).
- Copy & Paste between pads to move one pad to another or copy one pad to another.
- Saved Sets for easier and fast switching of arrangements.
- Preview Sounds
- Automatic Updates

## Change Log

## [1.3.0](https://github.com/MatthewCallis/super-pads/releases/tag/1.3.0) - 2026-09-14

- Updated Electron to 44.3.0 and refreshed dependencies.
- Updated external-link and drag-and-drop handling for modern Electron.
- Made SD-card saves recoverable with staged writes, backups, rollback, and interrupted-save recovery.
- Failed conversions now preserve pending edits for retry.
- Fixed stereo-to-mono conversion, trim handling when replacing samples, pad-10 metadata, and invalid-card error handling.
- Improved audio previews: switching pads stops playback, waveforms show the full sample, stale previews are cancelled, and special characters in file paths work correctly.
- Reduced resource usage through worker cleanup, waveform caching, faster WAV scans, limited conversion concurrency, and fewer UI rebuilds.
- Fixed accumulating loading animations and bank-dropdown text overlapping the arrow.
- Added npm run package to build all five release assets: macOS ARM64/x64 DMGs, Windows x64 portable executable, and Linux x64 AppImage/archive.
- Fixed oversized bundles and platform-specific FFmpeg packaging.
- Updated icon generation and stylesheet build commands.
- Added 20 automated tests and expanded Electron UI regression coverage.
- Requirements: macOS 13+ or Windows 10+. Building from source requires Node.js 24+.

## [1.2.0](https://github.com/MatthewCallis/super-pads) - 2020-04-04

- 🧰 Update to Electron 12 and rebuild.
- 🧰 More fixes for importing some even weirder WAV files.

## [1.1.1](https://github.com/MatthewCallis/super-pads) - 2020-01-02

- 🧰 Forgot to bump the version number in the previous release 🙃

## [1.1.0](https://github.com/MatthewCallis/super-pads) - 2020-01-01

- 🧰 Fix issue with some errant WAV files preventing SD cards from being read.

## [1.0.0](https://github.com/MatthewCallis/super-pads) - 2020-12-28

- 🧰 Released

## Contributors

- [Matthew Callis](https://github.com/MatthewCallis)

## Thanks

- [Paul Battley](https://github.com/threedaymonk) - His [Roland SP-404SX sample file format](https://gist.github.com/threedaymonk/701ca30e5d363caa288986ad972ab3e0) was a huge help.
- [Colin Espinas](https://codepen.io/Call_in/pen/pMYGbZ) - Weather App Design was the original basis for the app layout and made me think of making the app.
- [Himalaya Singh](https://codepen.io/himalayasingh/pen/EdVzNL) - The beautiful switches you see in the app.
- [Envato Tuts+](https://codepen.io/tutsplus/details/WROvdG) -The simple and effective tooltips.
- [David A.](https://codepen.io/meodai/pen/jVpwbP) - The trippy perin loading screen.
- [alphardex](https://codepen.io/alphardex) - The rainbow drop area background.

![Super Pads Loading Screen](https://raw.githubusercontent.com/MatthewCallis/super-pads/master/loading.png)

## Change Log

### v1.3.0 (2026-09-14)

- Updated Electron to 44.3.0 and refreshed dependencies.
- Updated external-link and drag-and-drop handling for modern Electron.
- Made SD-card saves recoverable with staged writes, backups, rollback, and interrupted-save recovery.
- Failed conversions now preserve pending edits for retry.
- Fixed stereo-to-mono conversion, trim handling when replacing samples, pad-10 metadata, and invalid-card error handling.
- Improved audio previews: switching pads stops playback, waveforms show the full sample, stale previews are cancelled, and special characters in file paths work correctly.
- Reduced resource usage through worker cleanup, waveform caching, faster WAV scans, limited conversion concurrency, and fewer UI rebuilds.
- Fixed accumulating loading animations and bank-dropdown text overlapping the arrow.
- Added npm run package to build all five release assets: macOS ARM64/x64 DMGs, Windows x64 portable executable, and Linux x64 AppImage/archive.
- Fixed oversized bundles and platform-specific FFmpeg packaging.
- Updated icon generation and stylesheet build commands.
- Added 20 automated tests and expanded Electron UI regression coverage.
- Requirements: macOS 13+ or Windows 10+. Building from source requires Node.js 24+.

## License

- [MIT](LICENSE)
