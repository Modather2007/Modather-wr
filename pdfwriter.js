// pdfwriter.js - builds a PDF from JPEG page images. No libraries needed.
// pages: [{ jpeg: Uint8Array, wPx, hPx, wPt, hPt }]   ->   Uint8Array (the PDF file)

export function buildPdf(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = []; // byte offset of object number n (index n-1)
  let pos = 0;

  const push = (data) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(bytes);
    pos += bytes.length;
  };
  const beginObj = (n) => {
    offsets[n - 1] = pos;
    push(`${n} 0 obj\n`);
  };
  const num = (v) => (Math.round(v * 100) / 100).toString();

  push("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");

  const pageObj = (i) => 3 + i * 3;
  const contentObj = (i) => 4 + i * 3;
  const imageObj = (i) => 5 + i * 3;

  beginObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  beginObj(2);
  const kids = pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ");
  push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((pg, i) => {
    beginObj(pageObj(i));
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pg.wPt)} ${num(pg.hPt)}] ` +
        `/Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>\nendobj\n`
    );

    const content = `q ${num(pg.wPt)} 0 0 ${num(pg.hPt)} 0 0 cm /Im0 Do Q\n`;
    beginObj(contentObj(i));
    push(`<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);

    beginObj(imageObj(i));
    push(
      `<< /Type /XObject /Subtype /Image /Width ${pg.wPx} /Height ${pg.hPx} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`
    );
    push(pg.jpeg);
    push("\nendstream\nendobj\n");
  });

  const total = 2 + pages.length * 3;
  const xrefPos = pos;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) xref += String(offsets[n - 1]).padStart(10, "0") + " 00000 n \n";
  push(xref);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
