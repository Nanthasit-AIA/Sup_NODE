"""Convert an engineer HAZOP-LOPA worksheet (company template SD-PS-F-0210) to JSON.

Usage (needs openpyxl):
    python scripts/worksheet_to_json.py "<worksheet.xlsx>" static/json_ref/01_hazop_worksheet.json
"""
import json
import re
import sys

import openpyxl

COLS = {"deviation": "A", "cause": "B", "consequence": "C", "S": "D", "L": "E", "R": "F", "ipls": "G",
        "independent": "H", "effective": "I", "auditable": "J", "safeguards": "K",
        "S_after": "L", "L_after": "M", "R_after": "N", "recommendation": "O", "comment": "P"}


def clean(v):
    return re.sub(r"\s+", " ", str(v)).strip(" /") if v is not None else ""


def convert(path, sheet="Hazop Node 1"):
    ws = openpyxl.load_workbook(path, data_only=True)[sheet]
    # merged cells only hold a value in their top-left cell: copy it to every cell of the range
    filled = {}
    for rng in ws.merged_cells.ranges:
        top_left = ws.cell(rng.min_row, rng.min_col).value
        for row in range(rng.min_row, rng.max_row + 1):
            for col in range(rng.min_col, rng.max_col + 1):
                filled[(row, col)] = top_left

    def get(row, key):
        cell = ws[f"{COLS[key]}{row}"]
        return clean(filled.get((row, cell.column), cell.value))

    rows, parameter = [], ""
    for r in range(1, ws.max_row + 1):
        if get(r, "deviation") == "Parameter:":
            parameter = get(r, "cause")
            continue
        consequence = get(r, "consequence")
        if not parameter or get(r, "deviation") == "DEVIATION" or not consequence or consequence in ("CONSEQUENCES", "N/A"):
            continue
        num = lambda key: int(get(r, key)) if get(r, key).isdigit() else None  # noqa: E731
        ipl_text = ws[f"G{r}"].value or ""
        rows.append({
            "id": f"W{len(rows) + 1}",
            "parameter": parameter,
            "deviation": get(r, "deviation"),
            "cause": get(r, "cause"),
            "consequence": consequence,
            "S": num("S"), "L": num("L"), "R": num("R"),
            "ipls": [{"text": clean(re.sub(r"^\d\)\s*", "", t)), "credit": int(m.group(1)) if (m := re.search(r"\(-(\d)\)", t)) else 0}
                     for t in str(ipl_text).split("\n") if t.strip()],
            "meets_ipl_criteria": {k: get(r, k) for k in ("independent", "effective", "auditable")},
            "safeguards": get(r, "safeguards"),
            "S_after": num("S_after"), "L_after": num("L_after"), "R_after": num("R_after"),
            "recommendation": get(r, "recommendation"),
            "comment": get(r, "comment"),
        })
    return rows


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    data = {"source": src.replace("\\", "/").split("/")[-1], "rows": convert(src)}
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"{len(data['rows'])} rows -> {dst}")
