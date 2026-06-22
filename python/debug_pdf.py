#!/usr/bin/env python3
"""
Quick diagnostic — prints raw extracted text from the first 2 pages of a PDF.
Usage: python3.13 python/debug_pdf.py "TRACK/YEAR/FILE.pdf"
"""
import sys
import pdfplumber
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
pdf_path = Path(sys.argv[1])
if not pdf_path.is_absolute():
    pdf_path = BASE_DIR / pdf_path

with pdfplumber.open(pdf_path) as pdf:
    for i, page in enumerate(pdf.pages[:2]):
        print(f"\n{'='*70}")
        print(f"PAGE {i + 1}")
        print('='*70)
        print(page.extract_text())
