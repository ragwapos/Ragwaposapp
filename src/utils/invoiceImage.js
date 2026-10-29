import html2canvas from "html2canvas";

// Rasterizes the same DOM node already used for the on-screen print preview
// (see PrintDocumentModal's .print-area) straight into a compressed JPEG
// blob — no PDF wrapping. A receipt is a small text document, not a photo,
// and WhatsApp already renders an image link as an inline thumbnail in the
// chat, so a PDF's extra structure/viewer step was pure overhead here: one
// less library on the critical path, one less encoding step, smaller
// upload, and the customer sees the receipt at a glance instead of having
// to open a separate PDF viewer.
// Integer scale so each QR module (a whole number of CSS px, see RealQR)
// lands on whole image pixels, and quality high enough that JPEG ringing
// doesn't blur the module edges — at 1.5 / 0.8 the ZATCA QR came out
// unscannable while the text still looked fine.
const SCALE = 2;
const JPEG_QUALITY = 0.92;

export async function generateInvoiceImage(domNode) {
  const canvas = await html2canvas(domNode, { scale: SCALE, backgroundColor: "#ffffff", useCORS: true, logging: false });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas_to_blob_failed"))), "image/jpeg", JPEG_QUALITY);
  });
}
