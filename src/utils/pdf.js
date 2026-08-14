import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";

// Rasterizes the same DOM node already used for the on-screen print preview
// (see PrintDocumentModal's .print-area) into a single-page PDF sized to
// match its own aspect ratio — a tall narrow receipt, not A4. Going through
// the real rendered DOM (rather than re-building the invoice as PDF text
// commands) means Arabic renders exactly as shaped/positioned by the
// browser, with zero extra font-embedding work.
const PX_TO_MM = 25.4 / 96; // 96 CSS px per inch

export async function generateInvoicePdf(domNode) {
  const canvas = await html2canvas(domNode, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
  const imgData = canvas.toDataURL("image/png");
  const widthMm = (canvas.width / 2) * PX_TO_MM;
  const heightMm = (canvas.height / 2) * PX_TO_MM;
  const pdf = new jsPDF({ unit: "mm", format: [widthMm, heightMm] });
  pdf.addImage(imgData, "PNG", 0, 0, widthMm, heightMm);
  return pdf.output("blob");
}
