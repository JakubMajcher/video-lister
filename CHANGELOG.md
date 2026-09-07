# Changelog

## 1.0.2

Firefox 140 or newer is now required. The declaration that this add-on collects no data
is only understood from that version, and Mozilla's validator warned about the mismatch
with the previous floor of 115. Firefox 140 is the current extended support release, so
nothing that Mozilla still supports loses the add-on.

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
