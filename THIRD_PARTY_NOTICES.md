# Third-party notices

## GeomMLBStadiums stadium paths

`data/stadium_paths.json` contains transformed stadium path data derived from
[GeomMLBStadiums](https://github.com/bdilday/GeomMLBStadiums). The exact
upstream revision used by the historical import was not recorded, so the file
is disabled for production analysis and retained only as an integrity-pinned,
watermarked offline reference.

GeomMLBStadiums declares the MIT License in its package metadata:

> Copyright (c) 2018 Ben Dilday
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Fence-profile source removed

An earlier `data/fences.json` snapshot identified
`danmorse314/dinger-machine` as its source, but that upstream repository did
not publish a license grant when reviewed on 2026-07-28. The derived values
have therefore been removed; the checked-in file is now an empty disabled
placeholder. The offline converter may process a user-supplied compatible CSV,
but users must verify their own source, permission, provenance, and calibration
before creating or distributing replacement data.

The repository's root MIT license does not grant rights in third-party inputs.
