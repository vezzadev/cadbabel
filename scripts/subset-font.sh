#!/usr/bin/env bash
#
# Rebuild public/fonts/archivo-latin-var.woff2 from the upstream OFL source.
#
#   ./scripts/subset-font.sh
#
# Shell, not Python: the build is two fontTools CLI calls, and nothing else in
# this repo is Python. Keeping it as shell leaves the exact
# `uv run --with fonttools,brotli` invocation on the page instead of hiding it
# in a dependency manifest -- no global installs and no venv in the tree.
#
# The output is byte-reproducible: SOURCE_DATE_EPOCH is pinned to the upstream
# file's own head.modified, so re-running this yields an identical artifact
# until upstream itself is re-released.
#
# ---------------------------------------------------------------------------
# Provenance, since no command was ever recorded: the predecessor of this
# file (git 0990aad) was never built here. It is byte-identical --
# sha256 8f704806dbedeaaeca334b11ec348bc3ac3a439d6431544b3afb54f534ee4967 --
# to Google's hosted "latin" subset of Archivo v25,
# https://fonts.gstatic.com/s/archivo/v25/k3kPo8UDI-1M0wlSV9XAw6lQkqWY8Q82sLydOxI.woff2
# whose unicode-range reads "... U+2122, U+2191, U+2193, U+2212 ...". U+2192
# was never in Google's latin subset, which is why the door arrow fell back to
# a system face. The codepoint list below is that subset's 230 codepoints with
# U+2192 added, i.e. their "U+2191, U+2193" merged into U+2191-2193.
#
# Residual difference against that predecessor -- the only one that is not a
# consequence of adding the arrow, and it is inert for web use, since the page
# matches on the CSS family name and never on these records: name IDs 3/4/6
# read "2.001;OMNI;ArchivoSemiBold-Regular", "Archivo SemiBold Regular" and
# "ArchivoSemiBold-Regular" there, rewritten by Google's serving pipeline.
# fontTools cannot reproduce those strings: `varLib.instancer
# --update-name-table` derives "ArchivoRoman-SemiBold" from the nameID 25
# variations prefix instead, identically on fontTools 4.29.1, 4.38.0, 4.44.0,
# 4.53.1 and 4.65.0. Google's strings also describe a single static SemiBold
# while this file ships wght 100-900 variable, so they would be wrong metadata
# to synthesise. We keep upstream's own OFL-authored names.
#
# Everything else matches exactly -- post 2.0, prep, gasp, the 12 layout
# feature tags, fvar, STAT, every OS/2 field, the recalculated head bbox, the
# hhea extents, head.flags and head.created/modified. The only other numbers
# that move are the ones the new glyph moves: numGlyphs and numberOfHMetrics
# 302 -> 303, cmap 230 -> 231 codepoints, OS/2 xAvgCharWidth 528 -> 529
# (it averages over one more glyph), and 34928 -> 35156 bytes.
# ---------------------------------------------------------------------------

set -euo pipefail

SOURCE_URL="https://raw.githubusercontent.com/google/fonts/main/ofl/archivo/Archivo%5Bwdth%2Cwght%5D.ttf"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="$ROOT/public/fonts/archivo-latin-var.woff2"

# Latin-1 and the punctuation/symbol picks Google's latin subset carries, plus
# the combining marks its composites decompose to. U+2192 is the door arrow.
CODEPOINTS='U+000D,U+0020-007E,U+00A0-00FF'
CODEPOINTS+=',U+0102,U+0131,U+0152-0153,U+02BC,U+02C6,U+02DA,U+02DC'
CODEPOINTS+=',U+0300-0301,U+0303-0304,U+0308-0309,U+0323'
CODEPOINTS+=',U+2009,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+2026'
CODEPOINTS+=',U+2032-2033,U+2039-203A,U+2044,U+20AC,U+2122'
CODEPOINTS+=',U+2191-2193,U+2212,U+2215,U+FEFF'

# Exactly the features the predecessor shipped. Spelled out rather than left to
# pyftsubset's default list, which omits pnum/tnum -- and those two are
# load-bearing: page.css sets font-variant-numeric: tabular-nums on .spec td
# and on the stats figures, which is a no-op without tnum in the font.
# Emphatically not '*' either: '*' drags in aalt/case/lnum/onum/ordn/sinf/
# subs/sups/zero and their glyph closure, which is how 480864a went from 302
# to 363 glyphs.
LAYOUT_FEATURES='ccmp,dnom,frac,kern,liga,locl,mark,mkmk,numr,pnum,rvrn,tnum'

PY="uv run --quiet --with fonttools,brotli"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> fetching $SOURCE_URL"
curl -fsSL "$SOURCE_URL" -o "$WORK/Archivo.ttf"

# Pin the build clock to upstream's head.modified so the artifact is stable.
# fontTools honours SOURCE_DATE_EPOCH; epoch_diff converts the 1904 font epoch.
SOURCE_DATE_EPOCH="$($PY python -c '
from fontTools.misc.timeTools import epoch_diff
from fontTools.ttLib import TTFont
import sys
print(TTFont(sys.argv[1])["head"].modified + epoch_diff)' "$WORK/Archivo.ttf")"
export SOURCE_DATE_EPOCH

# 1. Pin wdth to 100 and leave wght variable. Done first so the subsetter only
#    ever sees one axis, and gvar/HVAR deltas for wdth never reach the output.
echo "==> instancing wdth=100 (SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH)"
$PY fonttools varLib.instancer -q -o "$WORK/instanced.ttf" "$WORK/Archivo.ttf" wdth=100

# 2. Subset. Notable flags, all of them load-bearing:
#      --glyph-names            keep post format 2.0 (the default strips names)
#      no --no-hinting          keep the 7-byte prep program; --no-hinting
#                               would drop it, as 480864a did
#      --name-IDs+=14           keep the OFL licence URL next to the copyright
#      --recalc-bounds          shrink head bbox/hhea extents to the subset
#      --recalc-average-width   recompute OS/2 xAvgCharWidth over the subset
echo "==> subsetting"
$PY pyftsubset "$WORK/instanced.ttf" \
  --output-file="$OUTPUT" \
  --flavor=woff2 \
  --unicodes="$CODEPOINTS" \
  --layout-features="$LAYOUT_FEATURES" \
  --name-IDs+=14 \
  --glyph-names \
  --recalc-bounds \
  --recalc-average-width

# 3. Assert the shape. These are the properties the page and the predecessor
#    depend on; a mismatch means upstream moved and this script needs a
#    deliberate update, not a silently different font.
$PY python - "$OUTPUT" <<'PY'
import sys
from fontTools.ttLib import TTFont

font = TTFont(sys.argv[1])
codepoints = {cp for t in font["cmap"].tables for cp in t.cmap}
features = sorted(
    {r.FeatureTag for tag in ("GSUB", "GPOS") for r in font[tag].table.FeatureList.FeatureRecord}
)

checks = [
    ("fvar axes", [(a.axisTag, a.minValue, a.defaultValue, a.maxValue) for a in font["fvar"].axes],
     [("wght", 100.0, 600.0, 900.0)]),
    ("unitsPerEm", font["head"].unitsPerEm, 1000),
    ("numGlyphs", font["maxp"].numGlyphs, 303),
    ("codepoints", len(codepoints), 231),
    ("U+2192", 0x2192 in codepoints, True),
    ("post format", font["post"].formatType, 2.0),
    ("prep", "prep" in font, True),
    ("gasp", "gasp" in font, True),
    ("features", features, ["ccmp", "dnom", "frac", "kern", "liga", "locl",
                            "mark", "mkmk", "numr", "pnum", "rvrn", "tnum"]),
]

failed = False
for name, got, want in checks:
    ok = got == want
    failed |= not ok
    print(f"    {'ok  ' if ok else 'FAIL'} {name}: {got}" + ("" if ok else f" (expected {want})"))
if failed:
    sys.exit("subset does not match the expected shape")
PY

echo "==> wrote $OUTPUT ($(wc -c <"$OUTPUT") bytes)"
