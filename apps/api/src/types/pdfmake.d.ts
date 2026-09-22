// Minimal declarations for the parts of pdfmake 0.2 used server-side (billing PDFs).
declare module 'pdfmake' {
  type FontSet = { normal: Buffer; bold: Buffer; italics: Buffer; bolditalics: Buffer };
  export default class PdfPrinter {
    constructor(fonts: Record<string, FontSet>);
    createPdfKitDocument(definition: Record<string, unknown>, options?: Record<string, unknown>): NodeJS.ReadableStream & {
      end(): void;
    };
  }
}

declare module 'pdfmake/build/vfs_fonts.js' {
  const vfs: Record<string, string>;
  export default vfs;
}
