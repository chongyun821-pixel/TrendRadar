"""Render the standalone PDF exporter result, without browsing the application."""
import sys
import json
from pathlib import Path
import pymupdf
from pypdf import PdfReader

root = Path(sys.argv[1])
source = root / 'report.pdf'
reader = PdfReader(source)
assert len(reader.pages) == 7, f'Expected 7 pages, received {len(reader.pages)}'
doc = pymupdf.open(str(source))
pages = []
for index, page in enumerate(doc):
    page.get_pixmap(matrix=pymupdf.Matrix(1.3, 1.3), alpha=False).save(str(root / f'page-{index + 1}.png'))
    text = page.get_text()
    assert len(text.strip()) > 20
    pages.append({'page': index + 1, 'textCharacters': len(text), 'dimensions': [page.rect.width, page.rect.height]})
print(json.dumps({'pdfPages': len(doc), 'pages': pages}, ensure_ascii=False, indent=2))
(root / 'pdf-verification.json').write_text(json.dumps({'pdfPages': len(doc), 'pages': pages}, ensure_ascii=False, indent=2), encoding='utf-8')
