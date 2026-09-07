# Changelog

## 1.0.1

Each row now says what resolution the material has: 480p, 720p, 1080p, 4K and so on,
next to the container and codec. The number comes from the player when the page has one
loaded, from the text printed beside the link, or from the file address, and hovering the
badge says which of the three it was. No extra network requests are made to find out.

## 1.0.0

First release. It finds mp4, webm and ogg files in video, source and link elements, and
picks up DASH and HLS manifests that JavaScript players hide in the page markup. It
collapses duplicates, resolves relative paths, and speaks English or Polish depending on
your browser.
