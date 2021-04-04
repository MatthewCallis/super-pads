# Super Pads / スーパーパッド

![Super Pads](https://raw.githubusercontent.com/MatthewCallis/super-pads/master/example.png)

Super Pads helps manage samples on a SP-404SX. To use:

## Latest Version: v1.1.1 (2021-01-02)

- Fix issue with some errant WAV files preventing SD cards from being read.

- [Download for macOS](https://github.com/MatthewCallis/super-pads/releases/download/v1.1.1/Super.Pads-mac.dmg)
- [Download for Windows (x64)](https://github.com/MatthewCallis/super-pads/releases/download/v1.1.1/Super.Pads-win.exe)

Check the [releases page](https://github.com/MatthewCallis/super-pads/releases) for the latest version. Personally I leave the apps in the root of my SD card to make adjustments on any Windows or macOS machine. Linux support should _just work_ but I haven't tested it personally. SD Card files are changed and not backed up, use at your own risk.

## How to Use

1. Open the app
1. Select your SD Card root directory by clicking `Pick Folder`
1. Select the bank with the drop down and click on the pad you want to edit
1. Adjust parameters for existing pads, remove pads, or add pads with pick files / drag & drop files to be converted to Wave with [FFmpeg](https://ffmpeg.org/) behind the scenes.
1. Click `Write SD Card` to save your changed and convert files.
1. If any error comes up you will see it above the pad matrix, click it to dismiss.
1. If you think something should be working but it not, please [file an issue](https://github.com/MatthewCallis/super-pads/issues) or [tweet at me](https://twitter.com/superfamicom/status/1343989480160522240).

### Video Tutorials

- [Super Pads: a New Program for Loading Sounds Onto Your SP-404SX](https://www.youtube.com/watch?v=DIjpT0F07uU)
- [Short Super Pads Tutorial by pattyperk](https://streamable.com/k0yun0)

## Tempo Mode

`Tempo Mode` is another name for the `Time Modify` / `Time Adjust` settings when adjusting the BPM, where turning the knob all the way to the left is `Off`, so the sample will play at its original length, turning the knob all the way to the right is `Pattern` and will set the sample to play at the tempo of the pattern. The BPM can be between `40` and `200`, and `User` will use the custom value.

See page 30 of the manual.

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

## License

- [MIT](LICENSE)
