#!/usr/bin/env python3
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET


NS = {
    "a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def read_shared_strings(zip_file):
    if "xl/sharedStrings.xml" not in zip_file.namelist():
        return []

    root = ET.fromstring(zip_file.read("xl/sharedStrings.xml"))
    values = []
    for item in root.findall("a:si", NS):
        texts = [node.text or "" for node in item.findall(".//a:t", NS)]
        values.append("".join(texts))
    return values


def cell_value(cell, shared_strings):
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(".//a:t", NS)).strip()

    node = cell.find("a:v", NS)
    if node is None:
        return ""

    raw = node.text or ""
    if cell_type == "s":
        try:
            return str(shared_strings[int(raw)]).strip()
        except (ValueError, IndexError):
            return raw.strip()

    if re.fullmatch(r"-?\d+(?:\.\d+)?", raw):
        number = float(raw)
        if number.is_integer():
            return str(int(number))
        return f"{number:.6f}".rstrip("0").rstrip(".")
    return raw.strip()


def trim_row(row):
    while row and row[-1] == "":
        row.pop()
    return row


def read_workbook(path):
    with ZipFile(path) as zip_file:
        shared_strings = read_shared_strings(zip_file)
        workbook = ET.fromstring(zip_file.read("xl/workbook.xml"))
        rels = ET.fromstring(zip_file.read("xl/_rels/workbook.xml.rels"))
        rel_map = {
            rel.attrib["Id"]: rel.attrib["Target"]
            for rel in rels.findall("pr:Relationship", NS)
        }

        sheets = []
        for sheet in workbook.findall("a:sheets/a:sheet", NS):
            name = sheet.attrib["name"]
            rel_id = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
            target = rel_map[rel_id]
            sheet_path = "xl/" + target.lstrip("/") if not target.startswith("xl/") else target
            root = ET.fromstring(zip_file.read(sheet_path))

            rows = []
            for row in root.findall("a:sheetData/a:row", NS):
                values = trim_row([cell_value(cell, shared_strings) for cell in row.findall("a:c", NS)])
                if any(value.strip() for value in values):
                    rows.append(values)

            sheets.append({"name": name, "rows": rows})

        return sheets


def main():
    if len(sys.argv) < 3:
        print("Usage: import_forwarder_xlsx.py <input.xlsx> <output.js>", file=sys.stderr)
        return 2

    input_path = Path(sys.argv[1]).expanduser()
    output_path = Path(sys.argv[2]).expanduser()
    sheets = read_workbook(input_path)

    payload = {
        "forwarder": "上海圭順國際物流有限公司",
        "sourceFile": input_path.name,
        "importedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "sheetCount": len(sheets),
        "sheets": sheets,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "window.FORWARDER_RATE_DATA = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    print(f"Imported {len(sheets)} sheets -> {output_path}")


if __name__ == "__main__":
    raise SystemExit(main())
