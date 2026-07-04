#!/usr/bin/env bash
#
# build-tm.sh
#
# Builds a single multilingual TMX file from darktable's program PO files,
# for import into the dtdocs Weblate project translation memory.
#
# Unlike a hand-rolled converter, all the tricky parts (PO parsing, filtering
# of fuzzy/obsolete/untranslated entries, XML sanitisation) are delegated to
# po2tmx from the translate-toolkit, which does all of that natively. The only
# custom logic left is a small merge step that groups the bilingual TMX files
# po2tmx produces into one multilingual TMX (keyed by the English source), so
# the whole corpus is a single Weblate upload.
#
# The upload itself stays manual by design: wipe the project TM in Weblate,
# then upload the one output file — typically once per darktable release.
#
# Requirements: git, python3 (stdlib only for the merge), and po2tmx from the
# translate-toolkit (pip install translate-toolkit).

set -euo pipefail

# --- Configuration ----------------------------------------------------------

# darktable source repository and the ref to pull PO files from.
# DARKTABLE_REF accepts branch names and tags (e.g. "release-5.6.0"), but not
# bare commit SHAs (limitation of `git clone --branch`).
DARKTABLE_REPO="${DARKTABLE_REPO:-https://github.com/darktable-org/darktable.git}"
DARKTABLE_REF="${DARKTABLE_REF:-master}"

# Output TMX path (first CLI argument overrides the default).
OUTPUT="${1:-darktable-tm.tmx}"

SOURCE_LANG="en"

# darktable language code -> Weblate language code. Anything not listed is
# passed through unchanged. Extend if you find further mismatches.
# Note: associative array keys must match the PO basenames exactly.
declare -A LANG_MAP=(
    [zh_CN]=zh_Hans
    [zh_TW]=zh_Hant
    [sr@latin]=sr_Latn
)

# PO files to skip entirely: source-language variants darktable ships for
# internal use (en@truecase drives menu capitalisation) are not translation
# targets and would only pollute the TM.
SKIP_LANGS=" en@truecase "

# --- Dependency checks ------------------------------------------------------

for tool in git python3 po2tmx; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "error: required tool '$tool' not found in PATH" >&2
        if [ "$tool" = "po2tmx" ]; then
            echo "       po2tmx ships with the translate-toolkit:" >&2
            echo "       pip install translate-toolkit" >&2
        fi
        exit 1
    fi
done

# --- Fetch PO files ---------------------------------------------------------

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Fetching po/ from ${DARKTABLE_REPO} (${DARKTABLE_REF}) ..." >&2

# Shallow, blobless, sparse clone: only the po/ tree is materialised.
# stdout is discarded, stderr is kept so failures (bad ref, no network)
# stay diagnosable.
git clone \
    --quiet \
    --depth 1 \
    --branch "$DARKTABLE_REF" \
    --filter=blob:none \
    --sparse \
    "$DARKTABLE_REPO" \
    "$WORKDIR/darktable" >/dev/null

git -C "$WORKDIR/darktable" sparse-checkout set po >/dev/null

PO_DIR="$WORKDIR/darktable/po"

if [ ! -d "$PO_DIR" ]; then
    echo "error: po/ directory not found after checkout" >&2
    exit 1
fi

# --- Convert each PO to a bilingual TMX with po2tmx --------------------------

# po2tmx implicitly drops fuzzy, obsolete and untranslated entries, and takes
# care of XML-safe output, so no msgattrib prefilter is needed.
TMX_DIR="$WORKDIR/tmx"
mkdir -p "$TMX_DIR"

for po in "$PO_DIR"/*.po; do
    dt_lang="$(basename "$po" .po)"
    case "$SKIP_LANGS" in
        *" $dt_lang "*) continue ;;
    esac
    lang="${LANG_MAP[$dt_lang]:-$dt_lang}"
    po2tmx \
        --language "$lang" \
        --source-language "$SOURCE_LANG" \
        --progress none \
        -i "$po" \
        -o "$TMX_DIR/$lang.tmx"
done

# --- Merge the bilingual TMX files into one multilingual TMX -----------------

# This is the only custom logic in the pipeline. It consumes the well-formed
# XML that po2tmx just produced (no PO parsing, no content sanitisation), and
# simply regroups translation units by their English source segment.
python3 - "$TMX_DIR" "$OUTPUT" "$SOURCE_LANG" <<'PY'
import glob
import os
import sys
import xml.etree.ElementTree as ET

tmx_dir, output_path, source_lang = sys.argv[1], sys.argv[2], sys.argv[3]

XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"

# entries[source_string][lang] = target_string
entries = {}
lang_counts = {}

for tmx_path in sorted(glob.glob(os.path.join(tmx_dir, "*.tmx"))):
    tree = ET.parse(tmx_path)
    for tu in tree.iter("tu"):
        source = None
        targets = []
        for tuv in tu.iter("tuv"):
            lang = tuv.get(XML_LANG)
            seg = tuv.find("seg")
            text = seg.text if seg is not None and seg.text else ""
            if lang == source_lang:
                source = text
            elif text:
                targets.append((lang, text))
        if not source or not targets:
            continue
        by_lang = entries.setdefault(source, {})
        for lang, text in targets:
            # First translation per language wins (relevant when the same
            # msgid appears under several msgctxt values upstream).
            if lang not in by_lang:
                by_lang[lang] = text
                lang_counts[lang] = lang_counts.get(lang, 0) + 1

# Emit the merged multilingual TMX via ElementTree, so escaping and
# serialisation stay the library's job rather than ours.
tmx = ET.Element("tmx", version="1.4")
ET.SubElement(
    tmx,
    "header",
    creationtool="build-tm.sh",
    creationtoolversion="1.0",
    segtype="phrase",
    **{"o-tmf": "PO"},  # required by the TMX 1.4 DTD; hyphen forces dict form
    adminlang=source_lang,
    srclang=source_lang,
    datatype="plaintext",
)
body = ET.SubElement(tmx, "body")

for source in sorted(entries):
    tu = ET.SubElement(body, "tu")
    tuv = ET.SubElement(tu, "tuv", {XML_LANG: source_lang})
    ET.SubElement(tuv, "seg").text = source
    for lang in sorted(entries[source]):
        tuv = ET.SubElement(tu, "tuv", {XML_LANG: lang})
        ET.SubElement(tuv, "seg").text = entries[source][lang]

if hasattr(ET, "indent"):  # Python >= 3.9; indentation is cosmetic only
    ET.indent(tmx)
ET.ElementTree(tmx).write(output_path, encoding="UTF-8", xml_declaration=True)

# Self-check: re-parse the file we just wrote, so any malformed output fails
# here instead of during the Weblate upload.
ET.parse(output_path)

print("", file=sys.stderr)
print("Wrote {}".format(output_path), file=sys.stderr)
print("  unique source strings: {}".format(len(entries)), file=sys.stderr)
print("  languages: {}".format(len(lang_counts)), file=sys.stderr)
for lang in sorted(lang_counts):
    print("    {}: {}".format(lang, lang_counts[lang]), file=sys.stderr)
PY

echo "Done." >&2
