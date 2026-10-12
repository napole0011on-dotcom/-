// pdfmake 0.3 ships no types; only what kp-render uses.
declare module 'pdfmake' {
  interface PdfDocument {
    getBuffer(): Promise<Buffer>;
  }
  interface PdfMake {
    setFonts(fonts: Record<string, Record<string, string>>): void;
    setUrlAccessPolicy(cb: (url: string) => boolean): void;
    setLocalAccessPolicy(cb: (path: string) => boolean): void;
    createPdf(doc: Record<string, unknown>): PdfDocument;
  }
  const pdfmake: PdfMake;
  export default pdfmake;
}
