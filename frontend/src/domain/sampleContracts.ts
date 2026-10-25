/* Sample lease contracts for trying the import: fictional parties, typical Pakistani terms. The files are in
   public/samples, so trying one goes through the same reading as an uploaded file. The shop lease leaves out
   some terms on purpose, to show how the checklist asks for what a contract does not say; the office lease is
   a photographed page, which only AI can read; the machinery terms came by email; the portfolio is a spreadsheet
   of many leases. */

export type SampleFormat = 'pdf' | 'docx' | 'txt' | 'jpg' | 'xlsx';
export const FORMAT_LABELS: Record<SampleFormat, string> = { pdf: 'PDF', docx: 'Word', txt: 'Text', jpg: 'Scan', xlsx: 'Excel' };

export interface SampleContract {
    id: string; title: string; summary: string; tags: string[];
    /** The file name without its extension, and the formats it comes in (the first is offered first). */
    file: string; formats: SampleFormat[];
}

export const SAMPLE_CONTRACTS: SampleContract[] = [
    {
        id: 'warehouse',
        title: 'Warehouse lease, Karachi',
        summary: 'Five years, monthly rent in advance, yearly increase, deposit and a renewal option. States no rate, so you add your borrowing rate.',
        tags: ['Lessee', 'Renewal option', 'PKR'],
        file: 'Warehouse_lease_Karachi', formats: ['pdf', 'docx', 'txt'],
    },
    {
        id: 'vehicles',
        title: 'Vehicle fleet lease, Lahore',
        summary: 'Three years, quarterly payments in arrears, a markup rate and a purchase option.',
        tags: ['Lessee', 'Rate stated', 'Purchase option'],
        file: 'Vehicle_fleet_lease_Lahore', formats: ['pdf', 'docx', 'txt'],
    },
    {
        id: 'shop',
        title: 'Retail shop lease, Islamabad',
        summary: 'Leaves out the start date and when rent is paid, so you can see the checklist ask for them.',
        tags: ['Has gaps', 'Lessee'],
        file: 'Retail_shop_lease_Islamabad', formats: ['pdf', 'docx', 'txt'],
    },
    {
        id: 'office',
        title: 'Office lease, Karachi',
        summary: 'A photographed page with no text in it. Read with AI takes the terms from the image, including a rent-free month and a termination penalty.',
        tags: ['Scanned', 'Needs AI'],
        file: 'Office_lease_Karachi_scan', formats: ['jpg'],
    },
    {
        id: 'machinery',
        title: 'Machinery lease terms, Faisalabad',
        summary: 'Terms agreed by email, as plain text. A floating KIBOR rate, rent in arrears, a deposit and a purchase option.',
        tags: ['Email', 'KIBOR', 'Purchase option'],
        file: 'Machinery_lease_terms_email', formats: ['txt'],
    },
    {
        id: 'portfolio',
        title: 'Lease portfolio',
        summary: 'Eight leases in the spreadsheet template: offices, a warehouse, vans, equipment and a sublease. One has no rate, to show a row being skipped.',
        tags: ['8 leases', 'Spreadsheet'],
        file: 'Lease_portfolio_sample', formats: ['xlsx'],
    },
];

export const sampleUrl = (s: SampleContract, f: SampleFormat) => `${import.meta.env.BASE_URL}samples/${s.file}.${f}`;
export const sampleName = (s: SampleContract, f: SampleFormat) => `${s.file}.${f}`;

/** A sample as a file, as if it had been chosen from the computer. */
export async function sampleFile(s: SampleContract, f: SampleFormat): Promise<File> {
    const r = await fetch(sampleUrl(s, f));
    // A missing file comes back as the app's own page, so check what came back as well as the status
    if (!r.ok || (r.headers.get('content-type') || '').includes('text/html')) throw new Error(`The sample could not be loaded (${r.status}).`);
    const blob = await r.blob();
    return new File([blob], sampleName(s, f), { type: blob.type });
}
