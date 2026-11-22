# swift-site-generator

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Icesage101/swift-site-generator/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Icesage101/swift-site-generator/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in replacement for makefun-site 1.0.0, make.fun's own static site
generator. `solve.js` exports `run(input)`, which returns exactly the output
tree makefun-site's `build` returns for the same site: every page's
index.html, the index and tag pages, build-report.txt and each static file,
byte for byte. Same front matter, same template dialect, same Markdown
subset, same slug rule, same report. Just much less CPU time: on the
competition's practice set it builds all three cases in roughly a third of
the reference's time.

## How it is fast

- HTML escaping scans natively for the first special character and copies
  plain runs in bulk, instead of escaping character by character.
- The Markdown inline scanner works on index ranges of the original string
  and finds plain runs with a native scan, instead of recursing over sliced
  substrings.
- Block classification reads char codes, not stacks of regular expressions.
- Slugs are cached per build (titles, tags and headings repeat a lot), and a
  link target's resolution is cached per source directory.
- Templates that read only the build-wide values (site, tags, recent) are
  analysed once; their top-level include renders are cached for the build.
- Each page's card is built once and shared by every list that shows it.

Everything is one dependency-free ES module. No state is kept between calls:
each case is answered alone.

## Run it

The harness runs the driver, which reads the cases from `/input/cases.json`
and writes the answers to `/output/answers.json`:

```sh
node main.ts
```

To build one site directly, import `run` from `solve.js` and pass it a site
input of the shape `{ site, templates, files }`; it returns the output tree
as an object of path to text.

Entered in make.fun's [Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122) bounty.

---

<sub>Entered on [make.fun](https://make.fun/?ref=h6wxe48a&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>

