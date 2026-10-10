#!/usr/bin/env python3
"""
Convert the quiz spreadsheet (.xlsx) into questions.js for the quiz page.

Usage:
    python3 xlsx_to_questions.py                      # uses the first .xlsx in this folder
    python3 xlsx_to_questions.py "My Questions.xlsx"

Expected columns (header row, matched by name):
    Question Text | Option 1 | Option 2 | Option 3 | Option 4 | Correct Answer | Answer explanation
"Correct Answer" is the option number (1-4) or letter (A-D).
Uses only the Python standard library — no pip install needed.
"""
import glob
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
HERE = os.path.dirname(os.path.abspath(__file__))


def col_index(ref):
    letters = re.match(r"[A-Z]+", ref).group()
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_rows(path):
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
        sheet = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml", n))[0]
        rows = []
        for row in ET.fromstring(z.read(sheet)).iter(f"{{{NS['m']}}}row"):
            cells = {}
            for c in row.findall("m:c", NS):
                v, t = c.find("m:v", NS), c.get("t")
                if t == "s":
                    val = shared[int(v.text)]
                elif t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
                else:
                    val = v.text if v is not None else ""
                cells[col_index(c.get("r"))] = val
            if cells:
                rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
        return rows


def main():
    if len(sys.argv) > 1:
        src = sys.argv[1]
    else:
        found = sorted(glob.glob(os.path.join(HERE, "*.xlsx")))
        if not found:
            sys.exit("No .xlsx file found in this folder.")
        src = found[0]

    rows = read_rows(src)
    header = [h.strip().lower() for h in rows[0]]

    def col(name):
        if name not in header:
            sys.exit(f"Column '{name}' not found in header: {rows[0]}")
        return header.index(name)

    qi, ai = col("question text"), col("correct answer")
    oi = [col(f"option {k}") for k in range(1, 5)]
    ei = header.index("answer explanation") if "answer explanation" in header else None

    questions, problems = [], []
    for r_num, row in enumerate(rows[1:], start=2):
        get = lambda i: (row[i] if i is not None and i < len(row) else "").strip()
        text = get(qi)
        if not text:
            continue
        opts = [get(i) for i in oi]
        raw = get(ai).upper()
        if re.fullmatch(r"[1-4](\.0+)?", raw):
            ans = "ABCD"[int(float(raw)) - 1]
        else:
            ans = raw if raw in ("A", "B", "C", "D") else None
        if not all(opts) or ans is None:
            problems.append(f"row {r_num}: skipped (needs 4 options and answer 1-4/A-D)")
            continue
        q = {"question": text, "options": opts, "answer": ans}
        if get(ei):
            q["explanation"] = get(ei)
        questions.append(q)

    out = os.path.join(HERE, "questions.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write(f"/*\n * QUESTION BANK — generated from \"{os.path.basename(src)}\"\n")
        f.write(" * by xlsx_to_questions.py. Re-run that script after editing the spreadsheet.\n")
        f.write(" *   answer: correct option letter as listed in the sheet (A = Option 1 ... D = Option 4)\n */\n")
        f.write("const QUESTION_BANK = ")
        f.write(json.dumps(questions, indent=2, ensure_ascii=False))
        f.write(";\n")

    print(f"Wrote {len(questions)} questions to {out}")
    for p in problems:
        print("  WARNING", p)


if __name__ == "__main__":
    main()
