/* Ambient types for the host runtime (`window.claude`, present when the page runs
   inside the Claude viewer) and for the libraries loaded on demand from CDNs. */

export {};

declare global {
    /* ---- Claude page runtime ---- */
    interface ClaudeDocSnapshot { exists: boolean; data(): unknown }
    interface ClaudeQuerySnapshot { docs: { data(): unknown }[] }
    interface ClaudeDocRef {
        get(): Promise<ClaudeDocSnapshot>;
        set(value: unknown): Promise<void>;
        delete(): Promise<void>;
    }
    interface ClaudeQuery {
        onSnapshot(next: (snap: ClaudeQuerySnapshot) => void, error?: (err: unknown) => void): () => void;
        orderBy(field: string, dir?: 'asc' | 'desc'): ClaudeQuery;
        limit(n: number): ClaudeQuery;
        get(): Promise<ClaudeQuerySnapshot>;
    }
    interface ClaudeDb {
        doc(path: string): ClaudeDocRef;
        collection(path: string): ClaudeQuery;
    }
    interface ClaudeUserProfile { id: string; name?: string; guest?: boolean }
    interface ClaudeUserCapability {
        me(): Promise<ClaudeUserProfile>;
        can(permission: string): Promise<boolean>;
        profiles(ids: string[]): Promise<Record<string, ClaudeUserProfile>>;
        search(query: string): Promise<ClaudeUserProfile[]>;
        isOwner(): Promise<boolean>;
    }
    interface SampleTool {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        execute(input: Record<string, unknown>): unknown;
    }
    interface SampleMessage { role: 'user' | 'assistant'; content: string }
    interface SampleOptions {
        signal?: AbortSignal;
        modelTier?: 'default' | 'complex';
        images?: Blob[];
        tools?: SampleTool[];
        cache?: boolean;
        onText?: (progress: { text: string }) => void;
    }
    interface SampleLimits { images?: { maxPerCall?: number } }
    interface SampleCapability {
        (input: string | SampleMessage[], options?: SampleOptions): Promise<{ text: string }>;
        json(input: string, options?: SampleOptions): Promise<unknown>;
        limits(): Promise<SampleLimits | null>;
    }
    interface DownloadsCapability { save(file: { filename: string; data: string | Blob }): Promise<void> }
    interface ClaudeRuntime {
        use(name: 'db'): Promise<ClaudeDb | null>;
        use(name: 'user'): Promise<ClaudeUserCapability | null>;
        use(name: 'sample'): Promise<SampleCapability | null>;
        use(name: 'downloads'): Promise<DownloadsCapability | null>;
    }

    /* ---- Libraries loaded on demand (see utils/files.ts LIBS) ---- */
    type SheetCell = string | number | boolean | Date | null | undefined;
    interface XlsxWorkSheet { [cell: string]: unknown }
    interface XlsxWorkBook { SheetNames: string[]; Sheets: Record<string, XlsxWorkSheet> }
    interface XlsxStatic {
        utils: {
            book_new(): XlsxWorkBook;
            aoa_to_sheet(rows: SheetCell[][]): XlsxWorkSheet;
            book_append_sheet(wb: XlsxWorkBook, ws: XlsxWorkSheet, name: string): void;
            sheet_to_json(ws: XlsxWorkSheet, opts: { header: 1; raw: boolean; defval: string }): SheetCell[][];
        };
        write(wb: XlsxWorkBook, opts: { type: 'array'; bookType: 'xlsx' }): ArrayBuffer;
        read(data: string | ArrayBuffer, opts: { type: 'string' | 'array'; cellDates: boolean }): XlsxWorkBook;
    }
    interface PdfTextItem { str: string; transform: number[]; hasEOL?: boolean }
    interface PdfViewport { width: number; height: number }
    interface PdfPage {
        getTextContent(): Promise<{ items: PdfTextItem[] }>;
        getViewport(opts: { scale: number }): PdfViewport;
        render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
    }
    interface PdfDocument { numPages: number; getPage(n: number): Promise<PdfPage> }
    interface PdfJsStatic {
        GlobalWorkerOptions: { workerSrc: string };
        getDocument(src: { data: ArrayBuffer }): { promise: Promise<PdfDocument> };
    }
    interface AutoTableCellHook { section: string; row: { index: number }; column: { index: number }; cell: { styles: { halign?: string } } }
    interface JsPdfDocument {
        setFontSize(n: number): void;
        setTextColor(n: number): void;
        text(s: string, x: number, y: number): void;
        addPage(): void;
        autoTable(opts: Record<string, unknown> & { didParseCell?: (d: AutoTableCellHook) => void }): void;
        lastAutoTable?: { finalY: number };
        output(type: 'blob'): Blob;
    }
    interface JsPdfStatic { jsPDF: new (opts: { orientation: string; unit: string; format: string }) => JsPdfDocument }
    interface MammothStatic { extractRawText(opts: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }> }

    interface Window {
        claude?: ClaudeRuntime;
        XLSX?: XlsxStatic;
        pdfjsLib?: PdfJsStatic;
        jspdf?: JsPdfStatic;
        mammoth?: MammothStatic;
    }
}
