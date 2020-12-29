# Super Pads / スーパーパッド

![Super Pads](https://raw.githubusercontent.com/MatthewCallis/super-pads/master/example.png)

Super Pads helps manage samples on a SP-404SX. Open the app, select a SD Card root directory and adjust parameters and drag and drop files to be converted to wave with [FFmpeg](https://ffmpeg.org/) behind the scenes.

Makes use of two libraries I wrote to play with my own SP-404SX, [uttori-audio-padinfo](https://github.com/uttori/uttori-audio-padinfo) for parsing and writing the `PAD_INFO.BIN` file and [uttori-audio-wave](https://github.com/uttori/uttori-audio-wave) for adding the `RLND` header to the Wave files out of FFmpeg, and an Electron wrapper to make it easier to use.

_Note:_ I do not have an OG SP-404 or SP-404A but this could easily support those if someone is willing to help debug issues.

If you would like to suggest something or have found an issue please file a bug or message me on Twitter [@superfamicom](https://twitter.com/superfamicom).

If you would like to support development, listen to my songs, follow me, or playlist my songs 😏

- [Spotify](https://open.spotify.com/artist/0FYTwSXr4Q7Ujml4wW7Y97)
- [SoundCloud](https://soundcloud.com/superfamicom)
- [Bandcamp](https://matthewcallis.bandcamp.com/)
- [Audius](https://audius.co/superfamicom)

## Roadmap

Features I have planned to work on as time permits and there are others using the app. Roughly in order:

- Copy & Paste between pads to move one pad to another or copy one pad to another.
- Investigate alternatives to Electron like [Tauri](https://github.com/tauri-apps/tauri).
- Saved Sets for easier and fast switching of arrangements.
- Preview sounds.

## Change Log

## [1.0.0](https://github.com/MatthewCallis/super-pads) - 2020-12-27

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
