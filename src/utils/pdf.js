import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";

// Rasterizes the same DOM node already used for the on-screen print preview
// (see PrintDocumentModal's .print-area) into a single-page PDF sized to
// match its own aspect ratio — a tall narrow receipt, not A4. Going through
// the real rendered DOM (rather than re-building the invoice as PDF text
// commands) means Arabic renders exactly as shaped/positioned by the
// browser, with zero extra font-embedding work.
//
// SCALE/quality are deliberately modest — this is a small text receipt, not
// a photo, and this file has to upload fast enough that WhatsApp sharing
// doesn't feel like it's stuck (see the background-prep effect in
// PrintDocumentModal). JPEG at 0.85 quality is dramatically smaller than a
// PNG of the same canvas for this kind of mostly-white/text content while
// still reading perfectly clearly.
const SCALE = 1.5;
const JPEG_QUALITY = 0.85;
const PX_TO_MM = 25.4 / 96; // 96 CSS px per inch

export async function generateInvoicePdf(domNode) {
  const canvas = await html2canvas(domNode, { scale: SCALE, backgroundColor: "#ffffff", useCORS: true, logging: false });
  const imgData = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const widthMm = (canvas.width / SCALE) * PX_TO_MM;
  const heightMm = (canvas.height / SCALE) * PX_TO_MM;
  const pdf = new jsPDF({ unit: "mm", format: [widthMm, heightMm], compress: true });
  pdf.addImage(imgData, "JPEG", 0, 0, widthMm, heightMm);
  return pdf.output("blob");
}
